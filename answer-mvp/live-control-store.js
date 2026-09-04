import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const LIVE_MODES = Object.freeze(['dialogue', 'hosting']);

export const LIVE_CONTROL_LIMITS = Object.freeze({
  maxScripts: 100,
  maxTitleCharacters: 100,
  maxTextCharacters: 5_000,
  maxTotalTextCharacters: 100_000,
});

function liveControlError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function characterCount(value) {
  return [...value].length;
}

function requiredText(value, field, maximum) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw liveControlError(
      'LIVE_CONTROL_VALIDATION_ERROR',
      `${field} 必须是非空字符串。`,
    );
  }
  const cleaned = value.trim();
  if (characterCount(cleaned) > maximum) {
    throw liveControlError(
      'LIVE_CONTROL_VALIDATION_ERROR',
      `${field} 最长 ${maximum} 个字符。`,
    );
  }
  return cleaned;
}

export function prepareHostScripts(rawScripts) {
  if (!Array.isArray(rawScripts)) {
    throw liveControlError(
      'LIVE_CONTROL_VALIDATION_ERROR',
      '主持词必须是数组。',
    );
  }
  if (rawScripts.length > LIVE_CONTROL_LIMITS.maxScripts) {
    throw liveControlError(
      'LIVE_CONTROL_VALIDATION_ERROR',
      `主持词最多 ${LIVE_CONTROL_LIMITS.maxScripts} 段。`,
    );
  }

  const ids = new Set();
  let totalTextCharacters = 0;
  const scripts = rawScripts.map((rawScript, index) => {
    const location = `scripts[${index}]`;
    if (!rawScript || typeof rawScript !== 'object' || Array.isArray(rawScript)) {
      throw liveControlError(
        'LIVE_CONTROL_VALIDATION_ERROR',
        `${location} 必须是对象。`,
      );
    }
    if (
      Object.keys(rawScript).some(
        (key) => !['id', 'title', 'text'].includes(key),
      )
    ) {
      throw liveControlError(
        'LIVE_CONTROL_VALIDATION_ERROR',
        `${location} 只能包含 id、title 和 text。`,
      );
    }

    const id = requiredText(rawScript.id, `${location}.id`, 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) {
      throw liveControlError(
        'LIVE_CONTROL_VALIDATION_ERROR',
        `${location}.id 只能使用英文、数字、下划线和短横线。`,
      );
    }
    if (ids.has(id)) {
      throw liveControlError(
        'LIVE_CONTROL_VALIDATION_ERROR',
        `主持词 ID 重复：${id}。`,
      );
    }
    ids.add(id);

    const title = requiredText(
      rawScript.title,
      `${location}.title`,
      LIVE_CONTROL_LIMITS.maxTitleCharacters,
    );
    const text = requiredText(
      rawScript.text,
      `${location}.text`,
      LIVE_CONTROL_LIMITS.maxTextCharacters,
    );
    totalTextCharacters += characterCount(text);
    if (totalTextCharacters > LIVE_CONTROL_LIMITS.maxTotalTextCharacters) {
      throw liveControlError(
        'LIVE_CONTROL_VALIDATION_ERROR',
        `全部主持词合计不能超过 ${LIVE_CONTROL_LIMITS.maxTotalTextCharacters} 个字符。`,
      );
    }

    return Object.freeze({ id, title, text });
  });

  return Object.freeze(scripts);
}

function editableScripts(scripts) {
  return scripts.map((script) => ({ ...script }));
}

function serializedScripts(scripts) {
  return `${JSON.stringify(
    { version: 1, scripts: editableScripts(scripts) },
    null,
    2,
  )}\n`;
}

function revisionFor(scripts) {
  return createHash('sha256').update(serializedScripts(scripts)).digest('hex');
}

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, value, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function parsePersistedScripts(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw liveControlError(
      'LIVE_CONTROL_FILE_INVALID',
      '主持词文件不是有效的 JSON。',
      500,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.scripts)
  ) {
    throw liveControlError(
      'LIVE_CONTROL_FILE_INVALID',
      '主持词文件结构无效。',
      500,
    );
  }
  return prepareHostScripts(parsed.scripts);
}

export class LiveControlStore {
  constructor({ configPath, initialScripts = [], logger, now = () => new Date() }) {
    this.configPath = configPath;
    this.initialScripts = initialScripts;
    this.logger = logger;
    this.now = now;
    this.scripts = Object.freeze([]);
    this.revision = null;
    this.loadedAt = null;
    this.mode = 'dialogue';
    this.sequence = 0;
    this.lastCommand = null;
    this.saveInFlight = null;
  }

  async start() {
    try {
      this.scripts = parsePersistedScripts(
        await readFile(this.configPath, 'utf8'),
      );
      this.logger.info(
        { scriptCount: this.scripts.length },
        '已加载持久化主持词',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`服务启动失败：无法加载主持词：${error.message}`, {
          cause: error,
        });
      }
      this.scripts = prepareHostScripts(this.initialScripts);
      await atomicWrite(this.configPath, serializedScripts(this.scripts));
      this.logger.info(
        { scriptCount: this.scripts.length },
        '已创建初始主持词文件',
      );
    }

    this.revision = revisionFor(this.scripts);
    this.loadedAt = this.now().toISOString();
    this.mode = 'dialogue';
    this.sequence = 0;
    this.lastCommand = null;
  }

  publicSnapshot({ connectedClients = 0 } = {}) {
    return {
      mode: this.mode,
      sequence: this.sequence,
      scripts: editableScripts(this.scripts),
      revision: this.revision,
      loadedAt: this.loadedAt,
      connectedClients,
      lastCommand: this.lastCommand ? { ...this.lastCommand } : null,
    };
  }

  publicLiveState() {
    return {
      mode: this.mode,
      sequence: this.sequence,
    };
  }

  syncEvent() {
    return {
      type: 'sync',
      mode: this.mode,
      sequence: this.sequence,
      issuedAt: this.now().toISOString(),
    };
  }

  async saveScripts(rawScripts, expectedRevision) {
    if (this.saveInFlight) {
      await this.saveInFlight;
    }
    this.saveInFlight = this.performSaveScripts(
      rawScripts,
      expectedRevision,
    ).finally(() => {
      this.saveInFlight = null;
    });
    return this.saveInFlight;
  }

  async performSaveScripts(rawScripts, expectedRevision) {
    if (typeof expectedRevision !== 'string' || !expectedRevision) {
      throw liveControlError(
        'LIVE_CONTROL_VALIDATION_ERROR',
        '保存主持词时必须提供 revision。',
      );
    }
    if (expectedRevision !== this.revision) {
      throw liveControlError(
        'LIVE_CONTROL_VERSION_CONFLICT',
        '主持词已被其他管理页面修改，请刷新后重试。',
        409,
      );
    }

    const scripts = prepareHostScripts(rawScripts);
    await atomicWrite(this.configPath, serializedScripts(scripts));
    this.scripts = scripts;
    this.revision = revisionFor(scripts);
    this.loadedAt = this.now().toISOString();
    if (
      this.lastCommand &&
      !this.scripts.some((script) => script.id === this.lastCommand.scriptId)
    ) {
      this.lastCommand = null;
    }
    return this.publicSnapshot();
  }

  switchMode(mode) {
    if (!LIVE_MODES.includes(mode)) {
      throw liveControlError(
        'LIVE_CONTROL_MODE_INVALID',
        'mode 必须是 dialogue 或 hosting。',
      );
    }

    if (this.mode === mode) {
      return null;
    }
    this.mode = mode;
    this.sequence += 1;
    if (mode === 'dialogue') {
      this.lastCommand = null;
    }
    return {
      type: 'mode',
      mode,
      sequence: this.sequence,
      issuedAt: this.now().toISOString(),
    };
  }

  present(scriptId) {
    const script = this.scripts.find((entry) => entry.id === scriptId);
    if (!script) {
      throw liveControlError(
        'LIVE_CONTROL_SCRIPT_NOT_FOUND',
        '未找到要播报的主持词。',
        404,
      );
    }

    this.mode = 'hosting';
    this.sequence += 1;
    const issuedAt = this.now().toISOString();
    this.lastCommand = {
      scriptId: script.id,
      title: script.title,
      sequence: this.sequence,
      issuedAt,
    };
    return {
      type: 'present',
      mode: this.mode,
      sequence: this.sequence,
      issuedAt,
      script: { ...script },
    };
  }

  stop() {
    this.sequence += 1;
    this.lastCommand = null;
    return {
      type: 'stop',
      mode: this.mode,
      sequence: this.sequence,
      issuedAt: this.now().toISOString(),
    };
  }
}
