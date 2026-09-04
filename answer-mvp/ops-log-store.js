import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export const OPS_LOG_DEFAULTS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  defaultQueryLimit: 200,
  maxQueryLimit: 1_000,
  maxEntryBytes: 32 * 1024,
});

const LEVELS = new Set(['info', 'warning', 'error']);
const OUTCOMES = new Set(['success', 'rejected', 'failure']);
const SENSITIVE_DETAIL_KEYS = new Set([
  'password',
  'passphrase',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'token',
  'sessiontoken',
  'secret',
  'systemprompt',
  'question',
  'answer',
  'speechtext',
  'scripttext',
  'text',
  'content',
  'body',
  'headers',
]);

function compactString(value, maximum, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }
  const compacted = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return [...compacted].slice(0, maximum).join('') || fallback;
}

function normalizedDetailKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function sanitizeOpsDetails(value, depth = 0) {
  if (depth > 3) {
    return '[TRUNCATED]';
  }
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === 'string') {
    return compactString(value, 300);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => sanitizeOpsDetails(entry, depth + 1));
  }
  if (typeof value !== 'object') {
    return compactString(String(value), 300);
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value).slice(0, 30)) {
    const cleanKey = compactString(key, 80);
    if (!cleanKey) {
      continue;
    }
    sanitized[cleanKey] = SENSITIVE_DETAIL_KEYS.has(
      normalizedDetailKey(cleanKey),
    )
      ? '[REDACTED]'
      : sanitizeOpsDetails(entry, depth + 1);
  }
  return sanitized;
}

function prepareEntry(rawEntry, now) {
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    throw new TypeError('运维日志条目必须是对象');
  }
  const outcome = OUTCOMES.has(rawEntry.outcome)
    ? rawEntry.outcome
    : 'success';
  const level = LEVELS.has(rawEntry.level)
    ? rawEntry.level
    : outcome === 'failure'
      ? 'error'
      : outcome === 'rejected'
        ? 'warning'
        : 'info';
  const category = compactString(rawEntry.category, 40, 'system');
  const action = compactString(rawEntry.action, 100, 'unknown');
  const summary = compactString(rawEntry.summary, 240, '未提供动作摘要');
  const timestamp = now().toISOString();

  return {
    id: `${timestamp}-${randomUUID()}`,
    timestamp,
    level,
    category,
    action,
    outcome,
    summary,
    request: sanitizeOpsDetails(rawEntry.request ?? {}),
    details: sanitizeOpsDetails(rawEntry.details ?? {}),
  };
}

async function ignoreMissing(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return undefined;
  }
}

export class OpsLogStore {
  constructor({
    logPath,
    maxFileBytes = OPS_LOG_DEFAULTS.maxFileBytes,
    maxFiles = OPS_LOG_DEFAULTS.maxFiles,
    logger,
    now = () => new Date(),
  }) {
    this.logPath = logPath;
    this.maxFileBytes = maxFileBytes;
    this.maxFiles = maxFiles;
    this.logger = logger;
    this.now = now;
    this.writeQueue = Promise.resolve();
    this.startedAt = null;
    this.lastWriteAt = null;
    this.lastError = null;
  }

  async start() {
    if (
      !Number.isInteger(this.maxFileBytes) ||
      this.maxFileBytes < OPS_LOG_DEFAULTS.maxEntryBytes
    ) {
      throw new Error(
        `运维日志单文件上限不能小于 ${OPS_LOG_DEFAULTS.maxEntryBytes} 字节`,
      );
    }
    if (!Number.isInteger(this.maxFiles) || this.maxFiles < 1 || this.maxFiles > 10) {
      throw new Error('运维日志保留文件数必须在 1—10 之间');
    }
    await mkdir(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
    await this.ensureCurrentFile();
    this.startedAt = this.now().toISOString();
    this.lastError = null;
  }

  async ensureCurrentFile() {
    const handle = await open(this.logPath, 'a', 0o600);
    await handle.close();
    await chmod(this.logPath, 0o600);
  }

  async record(rawEntry) {
    const entry = prepareEntry(rawEntry, this.now);
    const operation = this.writeQueue
      .catch(() => {})
      .then(() => this.appendEntry(entry));
    this.writeQueue = operation;
    try {
      await operation;
      this.lastError = null;
      this.lastWriteAt = entry.timestamp;
      return entry;
    } catch (error) {
      this.lastError = {
        code: 'OPS_LOG_WRITE_FAILED',
        at: this.now().toISOString(),
      };
      this.logger?.error?.({ err: error }, '运维日志写入失败');
      throw error;
    }
  }

  async appendEntry(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > OPS_LOG_DEFAULTS.maxEntryBytes) {
      throw new Error('运维日志条目超过安全大小上限');
    }

    const currentSize = await stat(this.logPath)
      .then((fileStat) => fileStat.size)
      .catch((error) => {
        if (error.code === 'ENOENT') {
          return 0;
        }
        throw error;
      });
    if (currentSize > 0 && currentSize + lineBytes > this.maxFileBytes) {
      await this.rotate();
    }
    await appendFile(this.logPath, line, { encoding: 'utf8', mode: 0o600 });
  }

  async rotate() {
    if (this.maxFiles === 1) {
      await ignoreMissing(() => unlink(this.logPath));
      await this.ensureCurrentFile();
      return;
    }

    await ignoreMissing(() => unlink(`${this.logPath}.${this.maxFiles - 1}`));
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      await ignoreMissing(() =>
        rename(`${this.logPath}.${index}`, `${this.logPath}.${index + 1}`),
      );
    }
    await ignoreMissing(() => rename(this.logPath, `${this.logPath}.1`));
    await this.ensureCurrentFile();
  }

  async flush() {
    await this.writeQueue.catch(() => {});
  }

  filePathsOldestFirst() {
    const paths = [];
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      paths.push(`${this.logPath}.${index}`);
    }
    paths.push(this.logPath);
    return paths;
  }

  async scan() {
    await this.flush();
    const entries = [];
    let invalidLines = 0;
    let totalBytes = 0;
    let fileCount = 0;

    for (const filePath of this.filePathsOldestFirst()) {
      const source = await readFile(filePath, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') {
          return null;
        }
        throw error;
      });
      if (source === null) {
        continue;
      }
      fileCount += 1;
      totalBytes += Buffer.byteLength(source);
      for (const line of source.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            entries.push(entry);
          } else {
            invalidLines += 1;
          }
        } catch {
          invalidLines += 1;
        }
      }
    }

    return { entries, invalidLines, totalBytes, fileCount };
  }

  async query({ limit, level, category, outcome, search } = {}) {
    const parsedLimit = Number(limit);
    const selectedLimit = Number.isInteger(parsedLimit)
      ? Math.min(
          OPS_LOG_DEFAULTS.maxQueryLimit,
          Math.max(1, parsedLimit),
        )
      : OPS_LOG_DEFAULTS.defaultQueryLimit;
    const normalizedSearch = compactString(search, 120).toLocaleLowerCase();
    const scanned = await this.scan();
    const filtered = scanned.entries.filter((entry) => {
      if (level && entry.level !== level) {
        return false;
      }
      if (category && entry.category !== category) {
        return false;
      }
      if (outcome && entry.outcome !== outcome) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      const searchable = [
        entry.action,
        entry.summary,
        entry.request?.id,
        entry.request?.route,
        entry.details?.errorCode,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
      return searchable.includes(normalizedSearch);
    });

    return {
      entries: filtered.slice(-selectedLimit).reverse(),
      totalMatched: filtered.length,
      storedEntries: scanned.entries.length,
      invalidLines: scanned.invalidLines,
      totalBytes: scanned.totalBytes,
      fileCount: scanned.fileCount,
      retention: {
        maxFileBytes: this.maxFileBytes,
        maxFiles: this.maxFiles,
      },
      status: this.publicStatus(),
    };
  }

  async exportJsonl() {
    const scanned = await this.scan();
    return scanned.entries.map((entry) => JSON.stringify(entry)).join('\n') +
      (scanned.entries.length ? '\n' : '');
  }

  publicStatus() {
    return {
      status: this.lastError ? 'degraded' : 'ready',
      ready: !this.lastError,
      file: path.basename(this.logPath),
      startedAt: this.startedAt,
      lastWriteAt: this.lastWriteAt,
      errorCode: this.lastError?.code ?? null,
      errorAt: this.lastError?.at ?? null,
    };
  }
}
