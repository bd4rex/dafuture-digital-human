import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'dafuture_admin_session';
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;
const SCRYPT_KEY_LENGTH = 64;

function authError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validatePassword(value, { existing = false } = {}) {
  if (typeof value !== 'string') {
    throw authError('ADMIN_PASSWORD_INVALID', '管理密码必须是字符串。');
  }
  if (!existing && value.length < PASSWORD_MIN_LENGTH) {
    throw authError(
      'ADMIN_PASSWORD_INVALID',
      `管理密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符。`,
    );
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw authError(
      'ADMIN_PASSWORD_INVALID',
      `管理密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符。`,
    );
  }
  return value;
}

async function deriveCredentials(password, salt = randomBytes(16)) {
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    maxmem: 64 * 1024 * 1024,
  });
  return Object.freeze({
    version: 1,
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: Buffer.from(derived).toString('base64'),
  });
}

function prepareCredentials(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    raw.version !== 1 ||
    raw.algorithm !== 'scrypt' ||
    typeof raw.salt !== 'string' ||
    typeof raw.hash !== 'string'
  ) {
    throw new Error('管理密码文件格式无效');
  }

  let salt;
  let hash;
  try {
    salt = Buffer.from(raw.salt, 'base64');
    hash = Buffer.from(raw.hash, 'base64');
  } catch {
    throw new Error('管理密码文件编码无效');
  }
  if (salt.length < 16 || hash.length !== SCRYPT_KEY_LENGTH) {
    throw new Error('管理密码文件参数无效');
  }
  return Object.freeze({
    version: 1,
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  });
}

async function atomicWrite(targetPath, serialized) {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string') {
    return cookies;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies.set(name, value);
  }
  return cookies;
}

export class AdminAuthStore {
  constructor({ configPath, presetPassword = '', sessionTtlMs, secureCookies, logger }) {
    this.configPath = configPath;
    this.presetPassword = presetPassword;
    this.sessionTtlMs = sessionTtlMs;
    this.secureCookies = secureCookies;
    this.logger = logger;
    this.credentials = null;
    this.credentialSource = null;
    this.sessions = new Map();
    this.setupInFlight = false;
  }

  async start() {
    if (this.presetPassword) {
      const password = validatePassword(this.presetPassword);
      this.credentials = await deriveCredentials(password);
      this.credentialSource = 'environment';
      this.presetPassword = '';
      this.logger.info('已从环境变量加载管理密码');
      return;
    }

    let serialized;
    try {
      serialized = await readFile(this.configPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.logger.warn('尚未设置管理密码；等待首次访问管理页面时设置');
        return;
      }
      throw new Error(`无法读取管理密码文件：${error.message}`, { cause: error });
    }

    try {
      this.credentials = prepareCredentials(JSON.parse(serialized));
      this.credentialSource = 'file';
    } catch (error) {
      throw new Error(`服务启动失败：管理密码文件无效：${error.message}`, {
        cause: error,
      });
    }
    this.logger.info('已加载持久化管理密码');
  }

  setupRequired() {
    return !this.credentials;
  }

  async setup(password) {
    if (this.credentials || this.setupInFlight) {
      throw authError(
        'ADMIN_ALREADY_CONFIGURED',
        '管理密码已设置，不能再执行首次设置。',
        409,
      );
    }
    this.setupInFlight = true;
    try {
      const validated = validatePassword(password);
      const credentials = await deriveCredentials(validated);
      await atomicWrite(
        this.configPath,
        `${JSON.stringify(credentials, null, 2)}\n`,
      );
      this.credentials = credentials;
      this.credentialSource = 'file';
      this.logger.info('首次管理密码已安全保存');
    } finally {
      this.setupInFlight = false;
    }
  }

  async verify(password) {
    if (!this.credentials || typeof password !== 'string') {
      return false;
    }
    validatePassword(password, { existing: true });
    const salt = Buffer.from(this.credentials.salt, 'base64');
    const expected = Buffer.from(this.credentials.hash, 'base64');
    const actual = Buffer.from(
      await scrypt(password, salt, expected.length, {
        maxmem: 64 * 1024 * 1024,
      }),
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  removeExpiredSessions(now = Date.now()) {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }
  }

  createSession() {
    this.removeExpiredSessions();
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, {
      expiresAt: Date.now() + this.sessionTtlMs,
    });
    return token;
  }

  sessionToken(request) {
    return parseCookies(request.headers.cookie).get(SESSION_COOKIE) ?? '';
  }

  hasValidSession(request) {
    this.removeExpiredSessions();
    const token = this.sessionToken(request);
    const session = token ? this.sessions.get(token) : null;
    if (!session) {
      return false;
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroySession(request) {
    const token = this.sessionToken(request);
    if (token) {
      this.sessions.delete(token);
    }
  }

  cookie(token, request) {
    const secure =
      this.secureCookies === true ||
      (this.secureCookies !== false && request.protocol === 'https');
    const maxAge = Math.floor(this.sessionTtlMs / 1_000);
    return [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }

  clearCookie(request) {
    const secure =
      this.secureCookies === true ||
      (this.secureCookies !== false && request.protocol === 'https');
    return [
      `${SESSION_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }
}
