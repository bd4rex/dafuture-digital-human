#!/usr/bin/env node

import { spawn, execFile as execFileCallback } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '..');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readNumber(
  name,
  fallback,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, integer = false } = {},
) {
  const supplied = process.env[name];
  if (supplied === undefined || supplied === '') {
    return fallback;
  }
  const value = Number(supplied);
  if (
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} 必须是 ${minimum} 到 ${maximum} 之间的${integer ? '整数' : '数字'}`,
    );
  }
  return value;
}

function readOptionalInteger(name, { minimum = 1 } = {}) {
  const supplied = process.env[name];
  if (supplied === undefined || supplied === '') {
    return null;
  }
  return readNumber(name, null, {
    minimum,
    maximum: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
}

function readLevels() {
  const raw = process.env.LOAD_LEVELS ?? '10,25,50,100,200';
  const levels = raw.split(',').map((entry) => Number(entry.trim()));
  if (
    levels.length === 0 ||
    levels.some((value) => !Number.isInteger(value) || value < 1 || value > 10_000)
  ) {
    throw new Error('LOAD_LEVELS 必须是 1—10000 的逗号分隔整数');
  }
  return [...new Set(levels)].sort((left, right) => left - right);
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function average(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rounded(value, digits = 1) {
  return value === null || value === undefined
    ? null
    : Number(value.toFixed(digits));
}

function addReservoirSample(samples, value, seen, maximum) {
  if (samples.length < maximum) {
    samples.push(value);
    return;
  }
  const replacement = Math.floor(Math.random() * seen);
  if (replacement < maximum) {
    samples[replacement] = value;
  }
}

class PhaseMetrics {
  constructor({ maximumSamples, halfAt }) {
    this.maximumSamples = maximumSamples;
    this.halfAt = halfAt;
    this.total = 0;
    this.succeeded = 0;
    this.statusCounts = new Map();
    this.errorCounts = new Map();
    this.latencies = [];
    this.firstHalf = { total: 0, succeeded: 0, latencies: [] };
    this.secondHalf = { total: 0, succeeded: 0, latencies: [] };
  }

  record({ ok, status, errorCode, latencyMs, completedAt }) {
    this.total += 1;
    if (ok) {
      this.succeeded += 1;
    }
    const statusKey = String(status ?? 'network-error');
    this.statusCounts.set(statusKey, (this.statusCounts.get(statusKey) ?? 0) + 1);
    if (errorCode) {
      this.errorCounts.set(errorCode, (this.errorCounts.get(errorCode) ?? 0) + 1);
    }
    addReservoirSample(
      this.latencies,
      latencyMs,
      this.total,
      this.maximumSamples,
    );

    const half = completedAt < this.halfAt ? this.firstHalf : this.secondHalf;
    half.total += 1;
    if (ok) {
      half.succeeded += 1;
    }
    addReservoirSample(
      half.latencies,
      latencyMs,
      half.total,
      Math.max(1, Math.floor(this.maximumSamples / 2)),
    );
  }
}

function summarizeHalf(half) {
  return {
    requests: half.total,
    successRate: half.total ? half.succeeded / half.total : 0,
    p95Ms: percentile(half.latencies, 0.95),
  };
}

function summarizeResources(samples) {
  if (samples.length === 0) {
    return {
      measured: false,
      samples: 0,
      averageCpuPercent: null,
      maximumCpuPercent: null,
      averageRssMb: null,
      maximumRssMb: null,
      rssGrowthMb: null,
    };
  }

  const cpuValues = samples.map((sample) => sample.cpuPercent);
  const rssValues = samples.map((sample) => sample.rssMb);
  const edgeCount = Math.max(1, Math.floor(samples.length / 4));
  const firstRss = samples.slice(0, edgeCount).map((sample) => sample.rssMb);
  const lastRss = samples.slice(-edgeCount).map((sample) => sample.rssMb);
  return {
    measured: true,
    samples: samples.length,
    averageCpuPercent: rounded(average(cpuValues)),
    maximumCpuPercent: rounded(Math.max(...cpuValues)),
    averageRssMb: rounded(average(rssValues)),
    maximumRssMb: rounded(Math.max(...rssValues)),
    rssGrowthMb: rounded(average(lastRss) - average(firstRss)),
  };
}

async function sampleProcess(pid) {
  try {
    const { stdout } = await execFile('ps', [
      '-p',
      String(pid),
      '-o',
      'rss=',
      '-o',
      '%cpu=',
    ]);
    const parts = stdout.trim().split(/\s+/);
    if (parts.length < 2) {
      return null;
    }
    const rssKb = Number(parts[0]);
    const cpuPercent = Number(parts[1].replace(',', '.'));
    if (!Number.isFinite(rssKb) || !Number.isFinite(cpuPercent)) {
      return null;
    }
    return {
      at: new Date().toISOString(),
      rssMb: rssKb / 1024,
      cpuPercent,
    };
  } catch {
    return null;
  }
}

function startResourceMonitor(pid, intervalMs) {
  let stopped = false;
  const samples = [];
  const loop = (async () => {
    while (!stopped) {
      const sample = await sampleProcess(pid);
      if (sample) {
        samples.push(sample);
      }
      if (!stopped) {
        await sleep(intervalMs);
      }
    }
  })();

  return {
    samples,
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

async function runPhase({
  name,
  targetUrl,
  concurrency,
  durationSeconds,
  question,
  requestTimeoutMs,
  errorBackoffMs,
  monitorPid,
  resourceSampleMs,
  maximumLatencySamples,
}) {
  const startedAt = Date.now();
  const deadline = startedAt + durationSeconds * 1_000;
  const metrics = new PhaseMetrics({
    maximumSamples: maximumLatencySamples,
    halfAt: startedAt + (durationSeconds * 1_000) / 2,
  });
  const resourceMonitor = monitorPid
    ? startResourceMonitor(monitorPid, resourceSampleMs)
    : null;

  const worker = async () => {
    while (Date.now() < deadline) {
      const requestStartedAt = performance.now();
      let status = null;
      let ok = false;
      let errorCode = null;
      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question }),
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        status = response.status;
        const responseBody = await response.json().catch(() => null);
        ok =
          response.status === 200 &&
          typeof responseBody?.answer === 'string' &&
          responseBody.answer.length > 0 &&
          responseBody.speechText === responseBody.answer;
        if (!ok) {
          errorCode =
            typeof responseBody?.error === 'string'
              ? responseBody.error
              : response.status === 200
                ? 'INVALID_ANSWER_BODY'
                : `HTTP_${response.status}`;
        }
      } catch (error) {
        errorCode = error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'FETCH_FAILED';
      }

      metrics.record({
        ok,
        status,
        errorCode,
        latencyMs: performance.now() - requestStartedAt,
        completedAt: Date.now(),
      });
      if (!ok && errorBackoffMs > 0) {
        await sleep(errorBackoffMs);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (resourceMonitor) {
    await resourceMonitor.stop();
  }
  const finishedAt = Date.now();
  const elapsedSeconds = (finishedAt - startedAt) / 1_000;

  return {
    name,
    concurrency,
    requestedDurationSeconds: durationSeconds,
    elapsedSeconds: rounded(elapsedSeconds, 3),
    requests: metrics.total,
    succeeded: metrics.succeeded,
    failed: metrics.total - metrics.succeeded,
    successRate: metrics.total ? metrics.succeeded / metrics.total : 0,
    requestsPerSecond: elapsedSeconds ? metrics.total / elapsedSeconds : 0,
    successfulRequestsPerSecond: elapsedSeconds
      ? metrics.succeeded / elapsedSeconds
      : 0,
    latencyMs: {
      p50: percentile(metrics.latencies, 0.5),
      p95: percentile(metrics.latencies, 0.95),
      p99: percentile(metrics.latencies, 0.99),
      maximum: metrics.latencies.length ? Math.max(...metrics.latencies) : null,
      sampled: metrics.latencies.length,
    },
    firstHalf: summarizeHalf(metrics.firstHalf),
    secondHalf: summarizeHalf(metrics.secondHalf),
    statusCounts: Object.fromEntries(metrics.statusCounts),
    errorCounts: Object.fromEntries(metrics.errorCounts),
    resources: summarizeResources(resourceMonitor?.samples ?? []),
  };
}

function evaluateCapacity(summary, thresholds) {
  const reasons = [];
  if (summary.requests === 0) {
    reasons.push('没有完成任何请求');
  }
  if (summary.successRate < thresholds.minimumSuccessRate) {
    reasons.push(
      `成功率 ${(summary.successRate * 100).toFixed(2)}% < ${(thresholds.minimumSuccessRate * 100).toFixed(2)}%`,
    );
  }
  if (
    summary.latencyMs.p95 === null ||
    summary.latencyMs.p95 > thresholds.maximumP95Ms
  ) {
    reasons.push(
      `P95 ${rounded(summary.latencyMs.p95) ?? '无数据'} ms > ${thresholds.maximumP95Ms} ms`,
    );
  }
  if (
    summary.resources.measured &&
    summary.resources.averageCpuPercent > thresholds.maximumAverageCpuPercent
  ) {
    reasons.push(
      `平均 CPU ${summary.resources.averageCpuPercent}% > ${thresholds.maximumAverageCpuPercent}%`,
    );
  }
  if (
    summary.resources.measured &&
    summary.resources.maximumRssMb > thresholds.maximumRssMb
  ) {
    reasons.push(
      `峰值 RSS ${summary.resources.maximumRssMb} MB > ${thresholds.maximumRssMb} MB`,
    );
  }
  return { passed: reasons.length === 0, reasons };
}

function evaluateStability(summary, thresholds) {
  const result = evaluateCapacity(summary, thresholds);
  const reasons = [...result.reasons];
  if (
    summary.resources.measured &&
    summary.resources.rssGrowthMb > thresholds.maximumRssGrowthMb
  ) {
    reasons.push(
      `RSS 首尾增长 ${summary.resources.rssGrowthMb} MB > ${thresholds.maximumRssGrowthMb} MB`,
    );
  }

  const successRateDrop =
    summary.firstHalf.successRate - summary.secondHalf.successRate;
  if (successRateDrop > thresholds.maximumSuccessRateDrop) {
    reasons.push(
      `后半程成功率下降 ${(successRateDrop * 100).toFixed(2)} 个百分点`,
    );
  }

  const p95DriftRatio =
    summary.firstHalf.p95Ms && summary.secondHalf.p95Ms
      ? summary.secondHalf.p95Ms / summary.firstHalf.p95Ms
      : null;
  if (
    p95DriftRatio !== null &&
    p95DriftRatio > thresholds.maximumP95DriftRatio
  ) {
    reasons.push(
      `后半程 P95 为前半程的 ${p95DriftRatio.toFixed(2)} 倍`,
    );
  }

  return {
    passed: reasons.length === 0,
    reasons,
    successRateDrop: rounded(successRateDrop, 4),
    p95DriftRatio: rounded(p95DriftRatio, 3),
  };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) {
    throw new Error('无法为容量测试分配端口');
  }
  return port;
}

async function waitForUrl(url, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`容量测试服务提前退出，退出码 ${child.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) {
        return;
      }
    } catch {
      // 服务仍在启动。
    }
    await sleep(100);
  }
  throw new Error(`等待服务就绪超时：${url}`);
}

function appendLog(current, chunk) {
  return `${current}${chunk}`.slice(-12_000);
}

async function startMockModel({ delayMs, jitterMs, maximumConcurrency }) {
  let active = 0;
  let peakActive = 0;
  let requests = 0;
  let rejected = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    for await (const _chunk of request) {
      // 读完请求体，模拟正常的上游 HTTP 服务。
    }
    requests += 1;
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      if (maximumConcurrency && active > maximumConcurrency) {
        rejected += 1;
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'mock rate limit' } }));
        return;
      }
      const jitter = jitterMs ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
      await sleep(delayMs + jitter);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'capacity-test-model',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: 'answered',
                  answer: '这是容量测试的模拟回答。',
                }),
              },
            },
          ],
        }),
      );
    } finally {
      active -= 1;
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('模拟模型服务启动失败');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    stats: () => ({ requests, rejected, peakActive }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startIsolatedSystem(configuration) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'answer-capacity-'),
  );
  const mockModel = await startMockModel({
    delayMs: configuration.mockLlmDelayMs,
    jitterMs: configuration.mockLlmJitterMs,
    maximumConcurrency: configuration.mockLlmMaximumConcurrency,
  });
  const appPort = await reservePort();
  const contentPath = path.join(temporaryDirectory, 'content.json');
  const modelConfigPath = path.join(temporaryDirectory, 'model-config.json');
  const knowledgePath = path.join(temporaryDirectory, 'knowledge.json');
  const knowledgeFilesDirectory = path.join(
    temporaryDirectory,
    'knowledge-files',
  );

  await Promise.all([
    writeFile(
      contentPath,
      JSON.stringify([
        {
          id: 'capacity-test',
          questions: ['容量测试问题'],
          keywords: ['容量', '测试'],
          answer: '这是容量测试的已确认后台内容。',
        },
      ]),
      'utf8',
    ),
    writeFile(
      modelConfigPath,
      JSON.stringify({
        provider: 'openai-compatible',
        baseUrl: mockModel.baseUrl,
        apiKey: 'capacity-test-placeholder-key',
        model: 'capacity-test-model',
        answerMode: 'grounded',
        temperature: 0.2,
        maxTokens: 200,
        timeoutMs: Math.max(30_000, configuration.requestTimeoutMs),
        systemPrompt: '你是容量测试数字人。',
      }),
      'utf8',
    ),
  ]);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_DIRECTORY,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      LOG_LEVEL: 'error',
      CONTENT_FILE: contentPath,
      MODEL_CONFIG_FILE: modelConfigPath,
      KNOWLEDGE_FILE: knowledgePath,
      KNOWLEDGE_FILES_DIR: knowledgeFilesDirectory,
      ADMIN_AUTH_FILE: path.join(temporaryDirectory, 'admin-auth.json'),
      ADMIN_PASSWORD: 'capacity-test-admin-password',
      CONTENT_POLL_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', (chunk) => {
    childLog = appendLog(childLog, chunk);
  });
  child.stderr.on('data', (chunk) => {
    childLog = appendLog(childLog, chunk);
  });

  const answerUrl = `http://127.0.0.1:${appPort}/answer`;
  try {
    await waitForUrl(`http://127.0.0.1:${appPort}/ready`, child);
  } catch (error) {
    child.kill('SIGTERM');
    await mockModel.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw new Error(`${error.message}\n${childLog}`, { cause: error });
  }

  return {
    answerUrl,
    healthUrl: `http://127.0.0.1:${appPort}/ready`,
    monitorPid: child.pid,
    mockStats: mockModel.stats,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          sleep(5_000).then(() => {
            if (child.exitCode === null) {
              child.kill('SIGKILL');
            }
          }),
        ]);
      }
      await mockModel.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

function validatedTargetUrl(raw) {
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('LOAD_TARGET_URL 只支持 http 或 https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('LOAD_TARGET_URL 不得包含账号、密码、查询参数或锚点');
  }
  return parsed.toString();
}

async function checkHealth(url) {
  if (!url) {
    return { checked: false, ok: null, status: null };
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return { checked: true, ok: response.status === 200, status: response.status };
  } catch (error) {
    return { checked: true, ok: false, status: null, error: error?.name ?? 'ERROR' };
  }
}

function rowForConsole(summary, evaluation) {
  return {
    '阶段': summary.name,
    '并发': summary.concurrency,
    '请求数': summary.requests,
    '成功率': `${(summary.successRate * 100).toFixed(2)}%`,
    'RPS': rounded(summary.requestsPerSecond, 2),
    'P50(ms)': rounded(summary.latencyMs.p50),
    'P95(ms)': rounded(summary.latencyMs.p95),
    '平均CPU%': summary.resources.averageCpuPercent ?? '未采样',
    '峰值RSS(MB)': summary.resources.maximumRssMb ?? '未采样',
    '结果': evaluation.passed ? '通过' : '失败',
  };
}

function roundMemoryRecommendation(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.ceil(Math.max(256, value * 1.5) / 128) * 128;
}

async function main() {
  const levels = readLevels();
  const configuration = {
    mode: process.env.LOAD_TARGET_URL ? 'target' : 'isolated-mock',
    levels,
    stepSeconds: readNumber('LOAD_STEP_SECONDS', 10, {
      minimum: 1,
      maximum: 3_600,
      integer: true,
    }),
    warmupSeconds: readNumber('LOAD_WARMUP_SECONDS', 3, {
      minimum: 0,
      maximum: 600,
      integer: true,
    }),
    stabilitySeconds: readNumber('STABILITY_SECONDS', 60, {
      minimum: 1,
      maximum: 86_400,
      integer: true,
    }),
    stabilityConcurrency: readOptionalInteger('STABILITY_CONCURRENCY'),
    requestTimeoutMs: readNumber('LOAD_REQUEST_TIMEOUT_MS', 15_000, {
      minimum: 100,
      maximum: 300_000,
      integer: true,
    }),
    errorBackoffMs: readNumber('LOAD_ERROR_BACKOFF_MS', 100, {
      minimum: 0,
      maximum: 10_000,
      integer: true,
    }),
    resourceSampleMs: readNumber('RESOURCE_SAMPLE_MS', 1_000, {
      minimum: 200,
      maximum: 60_000,
      integer: true,
    }),
    maximumLatencySamples: readNumber('MAX_LATENCY_SAMPLES', 200_000, {
      minimum: 1_000,
      maximum: 2_000_000,
      integer: true,
    }),
    question: process.env.LOAD_QUESTION ?? '容量测试问题',
    mockLlmDelayMs: readNumber('MOCK_LLM_DELAY_MS', 800, {
      minimum: 0,
      maximum: 300_000,
      integer: true,
    }),
    mockLlmJitterMs: readNumber('MOCK_LLM_JITTER_MS', 200, {
      minimum: 0,
      maximum: 300_000,
      integer: true,
    }),
    mockLlmMaximumConcurrency: readNumber('MOCK_LLM_MAX_CONCURRENCY', 0, {
      minimum: 0,
      maximum: 100_000,
      integer: true,
    }),
  };
  if (!configuration.question.trim() || [...configuration.question].length > 500) {
    throw new Error('LOAD_QUESTION 必须是 1—500 个字符');
  }

  const thresholds = {
    minimumSuccessRate: readNumber('MIN_SUCCESS_RATE', 0.99, {
      minimum: 0,
      maximum: 1,
    }),
    maximumP95Ms: readNumber('MAX_P95_MS', 2_000, {
      minimum: 1,
      maximum: 300_000,
    }),
    maximumAverageCpuPercent: readNumber('MAX_AVG_CPU_PERCENT', 80, {
      minimum: 1,
      maximum: 10_000,
    }),
    maximumRssMb: readNumber('MAX_RSS_MB', 512, {
      minimum: 1,
      maximum: 1_000_000,
    }),
    maximumRssGrowthMb: readNumber('MAX_RSS_GROWTH_MB', 64, {
      minimum: 0,
      maximum: 1_000_000,
    }),
    maximumSuccessRateDrop: readNumber('MAX_SUCCESS_RATE_DROP', 0.01, {
      minimum: 0,
      maximum: 1,
    }),
    maximumP95DriftRatio: readNumber('MAX_P95_DRIFT_RATIO', 1.5, {
      minimum: 1,
      maximum: 100,
    }),
  };

  let system;
  let answerUrl;
  let healthUrl;
  let monitorPid = readOptionalInteger('LOAD_MONITOR_PID');
  if (configuration.mode === 'target') {
    if (process.env.ALLOW_BILLABLE_LOAD_TEST !== 'YES') {
      throw new Error(
        '指定 LOAD_TARGET_URL 可能调用真实模型并产生费用。确认是测试环境后，请同时设置 ALLOW_BILLABLE_LOAD_TEST=YES。',
      );
    }
    answerUrl = validatedTargetUrl(process.env.LOAD_TARGET_URL);
    healthUrl = process.env.LOAD_HEALTH_URL
      ? validatedTargetUrl(process.env.LOAD_HEALTH_URL)
      : null;
  } else {
    system = await startIsolatedSystem(configuration);
    answerUrl = system.answerUrl;
    healthUrl = system.healthUrl;
    monitorPid = system.monitorPid;
  }

  const cleanup = async () => {
    if (system) {
      const closing = system;
      system = null;
      await closing.close();
    }
  };
  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.once('SIGTERM', () => {
    void cleanup().finally(() => process.exit(143));
  });

  try {
    console.log(`\n测试模式：${configuration.mode}`);
    console.log(`问答目标：${answerUrl}`);
    console.log(
      monitorPid
        ? `资源监测 PID：${monitorPid}`
        : '资源监测：未配置（远程目标需在服务器侧另行采样）',
    );

    if (configuration.warmupSeconds > 0) {
      console.log(
        `预热：${levels[0]} 并发，${configuration.warmupSeconds} 秒`,
      );
      await runPhase({
        name: '预热',
        targetUrl: answerUrl,
        concurrency: levels[0],
        durationSeconds: configuration.warmupSeconds,
        question: configuration.question,
        requestTimeoutMs: configuration.requestTimeoutMs,
        errorBackoffMs: configuration.errorBackoffMs,
        monitorPid: null,
        resourceSampleMs: configuration.resourceSampleMs,
        maximumLatencySamples: configuration.maximumLatencySamples,
      });
    }

    const capacitySteps = [];
    let firstFailingConcurrency = null;
    for (const concurrency of levels) {
      console.log(
        `阶梯并发：${concurrency} 并发，${configuration.stepSeconds} 秒`,
      );
      const summary = await runPhase({
        name: `阶梯-${concurrency}`,
        targetUrl: answerUrl,
        concurrency,
        durationSeconds: configuration.stepSeconds,
        question: configuration.question,
        requestTimeoutMs: configuration.requestTimeoutMs,
        errorBackoffMs: configuration.errorBackoffMs,
        monitorPid,
        resourceSampleMs: configuration.resourceSampleMs,
        maximumLatencySamples: configuration.maximumLatencySamples,
      });
      const evaluation = evaluateCapacity(summary, thresholds);
      capacitySteps.push({ ...summary, evaluation });
      console.table([rowForConsole(summary, evaluation)]);
      if (!evaluation.passed) {
        firstFailingConcurrency = concurrency;
        break;
      }
    }

    const passingSteps = capacitySteps.filter((step) => step.evaluation.passed);
    const highestPassingTestedConcurrency = passingSteps.at(-1)?.concurrency ?? 0;
    const automaticallySelectedStabilityConcurrency = Math.max(
      1,
      Math.floor(
        (highestPassingTestedConcurrency || capacitySteps[0]?.concurrency || 1) *
          0.7,
      ),
    );
    const stabilityConcurrency =
      configuration.stabilityConcurrency ??
      automaticallySelectedStabilityConcurrency;

    console.log(
      `稳定性浸泡：${stabilityConcurrency} 并发，${configuration.stabilitySeconds} 秒`,
    );
    const stabilitySummary = await runPhase({
      name: '稳定性',
      targetUrl: answerUrl,
      concurrency: stabilityConcurrency,
      durationSeconds: configuration.stabilitySeconds,
      question: configuration.question,
      requestTimeoutMs: configuration.requestTimeoutMs,
      errorBackoffMs: configuration.errorBackoffMs,
      monitorPid,
      resourceSampleMs: configuration.resourceSampleMs,
      maximumLatencySamples: configuration.maximumLatencySamples,
    });
    const stabilityEvaluation = evaluateStability(
      stabilitySummary,
      thresholds,
    );
    console.table([rowForConsole(stabilitySummary, stabilityEvaluation)]);

    const finalHealth = await checkHealth(healthUrl);
    if (finalHealth.checked && !finalHealth.ok) {
      stabilityEvaluation.passed = false;
      stabilityEvaluation.reasons.push(
        `稳定性测试后就绪检查失败（HTTP ${finalHealth.status ?? '无响应'}）`,
      );
    }

    const observedRssValues = [
      ...passingSteps.map((step) => step.resources.maximumRssMb),
      stabilitySummary.resources.maximumRssMb,
    ].filter(Number.isFinite);
    const observedMaximumRssMb = observedRssValues.length
      ? Math.max(...observedRssValues)
      : null;
    const resourceSizing = {
      measured: observedMaximumRssMb !== null,
      observedMaximumRssMb,
      suggestedMemoryFloorMb: roundMemoryRecommendation(observedMaximumRssMb),
      note:
        configuration.mode === 'isolated-mock'
          ? '只包含 Node.js 问答服务，不包含外部大模型推理资源。'
          : monitorPid
            ? '资源数据来自 LOAD_MONITOR_PID 指定的本机进程。'
            : '未采集远程服务器资源，不能据此给出内存规格。',
    };

    const stableRps = stabilitySummary.successfulRequestsPerSecond;
    const report = {
      generatedAt: new Date().toISOString(),
      configuration: {
        ...configuration,
        targetUrl: answerUrl,
        monitorPid,
      },
      thresholds,
      capacity: {
        steps: capacitySteps,
        highestPassingTestedConcurrency,
        firstFailingConcurrency,
        boundaryFound: firstFailingConcurrency !== null,
        recommendedConcurrentRequests: stabilityEvaluation.passed
          ? stabilityConcurrency
          : null,
      },
      stability: {
        ...stabilitySummary,
        evaluation: stabilityEvaluation,
        finalHealth,
      },
      estimatedActiveUsersByAverageQuestionInterval: {
        explanation:
          '仅按稳定性阶段成功 RPS 乘以人均提问间隔粗估，不等于同时提问数。',
        seconds10: Math.floor(stableRps * 10),
        seconds30: Math.floor(stableRps * 30),
        seconds60: Math.floor(stableRps * 60),
      },
      resourceSizing,
      mockModel: system?.mockStats() ?? null,
    };

    const outputDirectory = path.resolve(
      process.env.LOAD_OUTPUT_DIR ?? path.join(PROJECT_DIRECTORY, 'output', 'load-tests'),
    );
    await mkdir(outputDirectory, { recursive: true });
    const timestamp = report.generatedAt.replace(/[:.]/g, '-');
    const reportPath = path.join(outputDirectory, `capacity-${timestamp}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(
      `\n本次最高已通过阶梯：${highestPassingTestedConcurrency} 并发请求`,
    );
    console.log(
      firstFailingConcurrency
        ? `首个失败阶梯：${firstFailingConcurrency} 并发请求`
        : '未触及失败边界；当前结果只是容量下界，不是极限值。',
    );
    console.log(
      `稳定性：${stabilityEvaluation.passed ? '通过' : '失败'}`,
    );
    if (stabilityEvaluation.reasons.length) {
      console.log(`稳定性失败原因：${stabilityEvaluation.reasons.join('；')}`);
    }
    if (resourceSizing.suggestedMemoryFloorMb) {
      console.log(
        `按峰值 RSS 留 50% 余量的内存下限：${resourceSizing.suggestedMemoryFloorMb} MB`,
      );
    }
    console.log(`完整 JSON 报告：${reportPath}`);

    if (!passingSteps.length || !stabilityEvaluation.passed) {
      process.exitCode = 1;
    }
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`\n容量测试失败：${error.message}`);
  process.exitCode = 1;
});
