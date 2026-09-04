# 问答功能、容量与稳定性测试

## TC-FUNC-001：核心问答链路

**目标**：验证访客问题经过真实 HTTP `POST /answer`、后台知识上下文和 OpenAI 兼容调用后，返回可显示、可播报的结构化答案。

**前置条件**：无需配置真实模型或 API Key；测试使用临时内容、临时模型配置和进程内模拟模型，不会改写正式 `content.json`。

**步骤**：

1. 启动临时问答服务。
2. 发送 `{"question":"请告诉我培训地点"}`。
3. 校验问答结果、知识匹配和上游模型请求。

**通过标准**：HTTP 200；`answered=true`；`answerStatus=answered`；`speechText` 与 `answer` 一致；匹配 `training-location`；访客返回中不出现 `source` 或 `references`。

```bash
npm run test:functional
```

## PT-CAP-STAB-001：容量和稳定性

### 要回答的问题

- 单个 Node.js 问答服务在给定资源下，能同时处理多少个问答请求？
- 该水位下的成功率、RPS、P50/P95/P99、CPU 和 RSS 内存是多少？
- 持续运行后是否有内存持续增长、错误率上升、延迟恶化或服务掉线？

### 测试流程

1. **预热**：在第一个并发水位运行，结果不纳入容量结论。
2. **阶梯并发**：默认依次测试 10、25、50、100、200 个同时请求，首次越过阈值后停止加压。
3. **稳定性浸泡**：默认使用“最高已通过阶梯×70%”的并发度持续运行，比较前后半程的成功率和 P95，同时比较内存首尾。
4. **就绪复查**：浸泡结束后再检查 `/ready`，确认服务没有因压力退出或转为不可用。

脚本采用闭环虚拟用户：每个虚拟用户收到答案后立即发出下一问，因此比普通访客行为更严苛。

### 默认安全模式

```bash
npm run test:capacity
```

默认启动一个独立的本地问答进程和模拟模型：

- 模拟模型延迟为 `800—1000 ms`。
- 只采样问答服务进程的 CPU 和 RSS，不把压测器与模拟模型的资源算进去。
- 不读取或调用真实模型配置，不产生模型费用。
- 报告写入 `output/load-tests/capacity-*.json`，该目录已被 Git 忽略。

### 正式容量和稳定性验收

建议在与正式机同规格的测试机上运行，并把模拟延迟设为实际模型的 P50 附近：

```bash
LOAD_LEVELS=10,25,50,100,200 \
LOAD_STEP_SECONDS=60 \
STABILITY_SECONDS=1800 \
MOCK_LLM_DELAY_MS=2000 \
MOCK_LLM_JITTER_MS=500 \
MAX_P95_MS=4000 \
npm run test:capacity
```

这个配置包含 5 分钟阶梯测试和 30 分钟稳定性浸泡。如果最高阶梯仍通过，只能说明“至少可承载该并发”，需扩大 `LOAD_LEVELS` 直到出现第一个失败阶梯，才能夹出容量边界。

### 完整链路测试

完整链路需要测试环境已配置真实模型。该测试会产生模型调用和费用，且可能触发供应商限流，所以脚本要求显式开关：

```bash
LOAD_TARGET_URL='https://test.example.edu/answer' \
LOAD_HEALTH_URL='https://test.example.edu/ready' \
ALLOW_BILLABLE_LOAD_TEST=YES \
LOAD_LEVELS=5,10,20,40 \
LOAD_STEP_SECONDS=60 \
STABILITY_SECONDS=900 \
MAX_P95_MS=8000 \
npm run test:capacity
```

不应直接对正式环境执行。远程模式默认无法采集服务器 CPU/内存；如果压测脚本与问答进程在同一台主机，可设置 `LOAD_MONITOR_PID=<问答进程PID>`，否则应同时从 Docker/Kubernetes/云监控取得服务端资源曲线。

### 默认通过阈值

| 指标 | 默认阈值 | 可调环境变量 |
| --- | ---: | --- |
| 成功率 | ≥ 99% | `MIN_SUCCESS_RATE` |
| P95 | ≤ 2000 ms | `MAX_P95_MS` |
| 问答进程平均 CPU | ≤ 80% | `MAX_AVG_CPU_PERCENT` |
| 问答进程峰值 RSS | ≤ 512 MB | `MAX_RSS_MB` |
| 稳定性首尾 RSS 增长 | ≤ 64 MB | `MAX_RSS_GROWTH_MB` |
| 后半程成功率下降 | ≤ 1 个百分点 | `MAX_SUCCESS_RATE_DROP` |
| 后半程 P95 / 前半程 P95 | ≤ 1.5 | `MAX_P95_DRIFT_RATIO` |

对真实模型的 P95 阈值应按数字人的用户体验 SLA 调整，不应沿用本地模拟模式的 2000 ms。

### 如何得出“多少用户”和“多少资源”

- `highestPassingTestedConcurrency` 是本次实测已通过的最高“同时问答请求数”。
- `recommendedConcurrentRequests` 是稳定性浸泡通过的工作水位，默认为最高通过阶梯的 70%。对外承诺建议使用这个值，不使用压测极限。
- “同时在线用户”不等于“同时提问用户”。如果高峰时估计 10% 在线用户会同时提问，则可以用 `recommendedConcurrentRequests ÷ 10%` 粗估在线用户规模，但还必须受真实模型配额限制。
- 内存可先按稳定性阶段峰值 RSS 的 1.5 倍向上取整，脚本在 `suggestedMemoryFloorMb` 中给出下限，最低不小于 256 MB。
- CPU 应以稳定工作水位下长期低于 60%、尖峰低于 80% 为配置目标。单个 Node.js 进程如果接近单核瓶颈，单纯增加 vCPU 不一定线性提升，应考虑多实例、限流与排队。
- 外部大模型 API 的并发限额、TPM/RPM 和响应延迟往往会先于 Node.js 服务成为瓶颈；本地模拟结果只用于问答服务本身的资源规格。

### 常用参数

| 参数 | 默认值 | 含义 |
| --- | ---: | --- |
| `LOAD_LEVELS` | `10,25,50,100,200` | 阶梯并发数 |
| `LOAD_STEP_SECONDS` | `10` | 每个阶梯时长 |
| `LOAD_WARMUP_SECONDS` | `3` | 预热时长 |
| `STABILITY_SECONDS` | `60` | 稳定性浸泡时长 |
| `STABILITY_CONCURRENCY` | 自动 70% | 手动指定稳定性并发 |
| `MOCK_LLM_DELAY_MS` | `800` | 模拟模型基础延迟 |
| `MOCK_LLM_JITTER_MS` | `200` | 模拟模型随机额外延迟 |
| `MOCK_LLM_MAX_CONCURRENCY` | `0` | 模拟上游并发限额，0 表示不限 |
| `LOAD_REQUEST_TIMEOUT_MS` | `15000` | 单请求超时 |
| `LOAD_MONITOR_PID` | 空 | 要采样的本机问答进程 PID |
