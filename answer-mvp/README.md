[English](README.en.md)

# “大未来”大模型数字人问答 MVP

这是一个可运行的双模式原型：对话模式把访客问题与持久化知识库交给后台配置的大语言模型，管理页直接用于导入和维护知识文件；主持模式由后台选择预先写好的主持词，实时通知所有已打开的数字人前台原样播报。

当前支持 OpenAI 兼容的 `/chat/completions` 接口。模型 API 地址、API Key、模型名、回答范围、回答风格、两类兜底话术和角色边界均可在 Web 工作台中配置。

## 本地运行

需要 Node.js 20.16—20.x，或 Node.js 22.3 及更高版本。

```bash
npm install
npm start
```

服务默认只监听本机 `http://127.0.0.1:8080`。首次打开管理页时需要设置一个至少 8 位的管理密码：

- `http://127.0.0.1:8080/`：双模式控制、文件知识库与模型配置工作台。
- `http://127.0.0.1:8080/avatar`：面向访客的数字人问答前台。
- `http://127.0.0.1:8080/health`：服务诊断、内容版本和模型连接状态（始终返回 HTTP 200）。
- `http://127.0.0.1:8080/ready`：问答就绪检查；不可用时返回 HTTP 503。

## 管理员登录

- 未登录时，管理地址只显示密码页；知识库和模型配置接口同时由服务端拦截。
- 没有预设密码时，首次访问即可直接设置密码，不限制访问地址或页面来源；本机、局域网或 Docker 访问方式一致。
- 密码只以 scrypt 加盐哈希保存到 `admin-auth.json`，文件权限为 `0600`，不保存明文。
- 登录后使用 HttpOnly、SameSite=Strict 会话 Cookie，默认 8 小时过期；服务重启或点击“退出登录”后会话失效。
- `ADMIN_API_KEY` 仍可作为 Bearer 密钥供自动化客户端调用；未单独设置 `ADMIN_PASSWORD` 时，它也是 Web 登录密码。

首次启动时模型处于“等待配置”状态。打开工作台，点击“模型设置”，至少填写：

1. API 地址，例如服务商提供的 `https://服务地址/v1`。
2. API Key。
3. 模型名称，即服务商提供的模型 ID。

点击“保存并测试连接”会先用候选配置发起一次很短的真实模型请求，验证成功后才落盘并切换。通过“保存设置”修改 API 地址、Key 或模型名时也采用同一保护；只调整回答范围、参数、回答风格、兜底话术或角色边界时不会重复测试。模型请求可能产生少量费用。

## 模型配置安全

模型设置写入独立的 `model-config.json`，不会写进 `content.json`：

- API Key 仅由服务端读取，`GET /api/model-config` 永不返回 Key 明文。
- 页面重新打开后只显示“服务器已保存”，Key 输入框保持空白。
- 留空保存会保留已有 Key；只有勾选“清除服务器上已保存的 API Key”才会删除。
- 完整的连接配置在变更时会先独立验证；验证失败会保留原有内存配置、磁盘文件和可用状态。
- 文件以 `0600` 权限原子写入，并已加入 `.gitignore`。
- 仓库只提供不含真实 Key 的 `model-config.example.json`。

本机运行时的默认路径为 `answer-mvp/model-config.json`。Docker 中使用 `/data/model-config.json`。

## 回答范围

模型设置提供两种模式：

- `仅依据后台内容`：模型只能基于知识库列表中已导入的文件回答；资料不足时返回后台配置的“知识不足话术”。
- `允许补充一般知识`：优先使用后台内容，可以补充通用知识，但不得编造本项目专属的日期、地点、费用、人员或规则。

无论选择哪种模式，文件知识都只是模型的知识上下文，不会被接口直接当作最终答案返回。历史 `content.json` 不再隐式参与回答。

正常回答由模型依据“回答风格”自然组织。模型只负责报告是否具有可靠答案；一旦返回 `no_answer`，服务端会忽略模型自行编写的拒答内容，改用管理员配置的知识不足话术。模型未配置、连接失败、超时或响应异常时，接口保持相应的 HTTP 错误状态和错误码，但数字人前台显示并播报服务异常话术，技术原因只留在运维日志中。

## Web 工作台

工作台顶部的选项卡同时也是运行模式开关：

- **对话模式**：管理页直接显示文件知识库，访客可以文字或语音提问，服务调用已配置的大语言模型并结合知识库生成答案。
- **主持模式**：前台问答立即暂停，后台可以维护多段主持词，选择任意一段后点击“保存并播报到前台”。主持词不经过大语言模型改写。
- 模式、播报和停止指令通过同源 SSE 实时下发给所有已打开的前台。新播报会中断上一段；“停止当前播报”只停止语音并保持主持待命，“返回对话模式”才恢复访客问答。
- 主持词持久化到 `host-scripts.json`，使用 revision 防止多个管理页面静默覆盖。服务重启后文稿仍在，但运行模式恢复为对话模式，也不会自动重播旧指令。

当前 MVP 对同一服务实例下的全部前台统一控制，不区分会场或设备分组。

### 运维日志

点击页头“运维日志”可按类别、结果、级别和关键词查看近期执行记录，也可下载 JSONL 文件用于进一步排错。当前记录范围包括：

- 服务初始化、监听和停止。
- 管理密码设置、登录成功/失败、限流和退出。
- 人工知识保存、文件知识导入/删除/下载、模型配置保存和连接测试。
- 对话/主持模式切换、主持词保存、播报下发和停止。
- 每次问答调用的成功、拒绝或失败状态。

每条日志包含时间、动作、请求编号、接口路由、操作者类型、客户端 IP、HTTP 状态码、执行耗时和错误码。每轮对话还保存完整提问和最终返回的回答（包括兜底），用 `turnId` 关联收到提问、检索、模型结果与前台播报；上游 401、429、500 等状态独立记录。只允许登录后的后台查询、搜索正文和下载。密码、Cookie、Authorization、API Key、系统提示词、未参与回答的知识全文和主持词全文仍不记录；正文中出现当前配置的 Key 或预设密码时会替换为 `[REDACTED]`。

前台上报准备、开始、完成、失败、取消、静音和不支持语音等状态，后台主持区显示当前指令的反馈汇总。它们是浏览器报告，不代表人工确认扬声器可听见。断网事件在当前标签页暂存并在恢复后补传（最多 200 条）；持续离线并关闭标签页可能无法补传。日志沿用 5 MB × 3 文件轮转，需长期留存时请定期导出。

日志以 `0600` 权限写入 `operations.jsonl`。默认单文件 5 MB，保留当前文件及两个轮转文件；后台只展示文件名，不公开服务器绝对路径。主持播报中的 `connectedClients` 表示服务器下发时已连接的前台数，不等同于终端扬声器已经成功播放。

知识库管理区直接显示在对话模式中，不再提供人工问法录入和后台问答试运行。当前支持：

- 导入 UTF-8 编码的 TXT、Markdown、CSV、JSON，以及 DOCX 和含文本层的 PDF；扫描 PDF 需要先做 OCR。
- 在提交前查看文件名、大小和导入方式；每次最多 10 个文件，单个最大 10 MB，合计最大 30 MB。
- 选择“追加”并自动跳过相同 SHA-256 内容，或确认后“替换”全部现有知识文件。
- 查看提取预览、下载原文件，或删除单个文件及其知识片段。
- 将原文件持久化到 `knowledge-files/`，将提取文字和分片索引持久化到 `knowledge.json`；Docker 中均位于 `/data` 卷。

模型区支持：

- 配置 OpenAI 兼容 API 地址、API Key 与模型名称。
- 切换回答范围，设置随机度、最大输出 Tokens 和超时。
- 分别编辑回答风格、知识不足话术、服务异常话术和角色与事实边界。
- 主动测试模型连接。

问答时，小知识库在 24,000 字符预算内全量提供给模型，避免换一种问法就漏掉已有资料。超过预算后使用同义表达扩展与字面相关度排序，最多选取 12 个文件片段；零匹配时也提供有界的资料回退。此方案适合 demo，不保证大型知识库任意语义问法都召回，资料扩大后应专项评估检索。文件名不作为访客端“资料来源”展示。

## 数字人前台

前台使用四段预生成透明视频表现四种状态：

```text
对话模式：提交问题 → thinking → 模型答案就绪 → speaking → idle
后台切换主持模式 → 前台问答锁定并等待指令
后台点击一段主持词 → presenting → 原样播报 → 主持待命
后台点击另一段 → 立即中断上一段并播报新内容
后台停止 → 主持待命；后台返回对话模式 → 恢复问答
```

当前播报使用浏览器本地语音合成，并优先选择普通话男声：macOS/Chrome 首选 `Reed`，再依次尝试 `Eddy`、`Rocko` 以及 Windows 常见的云希、云健、云扬、康康等男声。语速和音高在 `public/avatar-config.json` 的 `speech` 字段中配置。浏览器没有这些音色时会降级到本机可用的中文语音，因此正式部署如需跨设备保持同一音色，应接入服务端 TTS。视频不可用或用户启用“减少动画”时，页面会降级为轻量动画，问答仍可使用。

除文字输入外，访客可以点击输入框右侧的麦克风直接说出问题。当前使用浏览器 `SpeechRecognition`/`webkitSpeechRecognition` 完成单轮普通话识别，显示临时识别结果，并在获得最终文本后自动提交。首次使用需由访客主动点击并允许麦克风权限；不支持语音识别或权限被拒绝时，页面会给出提示并保留完整的文字输入能力。正式部署应使用 HTTPS，避免反复请求麦克风权限。

### 外部语音模型替换边界

`public/avatar-config.json` 中的 `speech.provider` 和 `speechInput.provider` 当前均为 `browser`。前端已按 provider 分离播报与语音输入入口，后续接入外部模型时保持以下边界：

- ASR provider 负责把一次录音转换为最终问题文本，再复用现有表单提交和问答流程。
- TTS provider 负责把 `speechText` 转换为可播放音频，并以开始、结束和取消事件驱动现有数字人状态机。
- 第三方 API Key 只保存在服务端；浏览器只调用同源代理接口，不直接持有供应商密钥。
- 浏览器识别引擎可能使用厂商的远端服务，不应把它视为必然的本地处理；涉及学生或访客敏感信息时，应按隐私要求选择并配置正式 ASR 服务。
- 外部服务不可用时可回退到当前浏览器语音；相同音色与文本可按哈希缓存，减少等待时间和调用成本。

手动预览四态：

```text
http://127.0.0.1:8080/avatar?preview=1
```

视频替换方法见 `public/avatar-media/README.md`；数字人名称、欢迎语和素材路径在 `public/avatar-config.json` 中配置，主持词统一在 Web 工作台维护。旧样例快捷问题已停用。前台缓存当前服务异常话术，请求断连或代理响应无效时仍会显示并尝试播报；实际发声仍取决于浏览器语音能力和声音开关。

主持控制使用实例 ID、指令序号和当前播放指令号同步；过期状态不会覆盖新指令，重连可以获知已错过的停止。控制通道断线时暂停旧播报，不自动重放，需后台重新下发。健康检查不再改变 SSE 控制顺序。语音失败、取消、静音不再显示“播报完成”。

## 接口契约

### `POST /answer`

请求：

```json
{
  "question": "前台怎么调用问答接口？"
}
```

模型配置完成且调用成功时：

```json
{
  "answered": true,
  "answerStatus": "answered",
  "answerStatusSource": "structured",
  "answer": "模型结合后台内容生成的回答。",
  "speechText": "模型结合后台内容生成的回答。",
  "model": "已配置的模型 ID",
  "knowledgeContext": {
    "contextIds": ["frontend-integration", "project-introduction"],
    "matchedIds": ["frontend-integration"]
  }
}
```

`answerStatus` 是回答状态，正常响应为 `answered` 或 `no_answer`，服务异常响应为 `error`；`answered` 仅为兼容旧前端的布尔值。服务优先读取模型返回的结构化状态；不支持结构化输出的兼容服务会标记 `answerStatusSource: "inferred"` 并使用稳健的拒答识别。`knowledgeContext.contextIds` 表示实际发送给模型的内容条目，`matchedIds` 表示服务端启发式匹配到的条目；两者都不声称模型在答案中引用或实际采用了某一条内容。

模型未配置时返回 HTTP `503`：

```json
{
  "error": "MODEL_NOT_CONFIGURED",
  "answered": false,
  "answerStatus": "error",
  "answerStatusSource": "system",
  "answer": "抱歉，我现在暂时无法完成查询。请稍后再试，或者请工作人员帮您进一步确认。",
  "speechText": "抱歉，我现在暂时无法完成查询。请稍后再试，或者请工作人员帮您进一步确认。",
  "message": "抱歉，我现在暂时无法完成查询。请稍后再试，或者请工作人员帮您进一步确认。"
}
```

模型连接、超时和响应错误同样返回非 2xx 状态与结构化错误码，并携带当前配置的服务异常话术。前台会把该话术作为一次可播报回答处理；运维仍可依据 HTTP 状态和错误码排查。

主持模式开启时，`POST /answer` 返回 HTTP `409` 和 `HOSTING_MODE_ACTIVE`，前台本身也会锁定文字、快捷问题和麦克风入口。

问题最多 500 个字符。联调环境可用 `CORS_ORIGIN` 限定允许调用的前台域名。

### 模型配置接口

- `GET /api/model-config`：读取非敏感设置、回答风格、两类兜底话术、`hasApiKey` 和最近一次连接状态。
- `PUT /api/model-config`：保存设置；空 Key 保留旧值。完整连接字段发生变化时先验证后切换，也可显式发送 `testConnection: true`；只修改回答风格或兜底话术不会调用模型。
- `POST /api/model-config/test`：使用已保存设置发起一次连接测试。

模型接口、`GET/PUT /api/content`、知识库和主持控制接口使用相同的后台登录保护。

### 知识库接口

- `GET /api/knowledge`：读取已导入文件摘要、提取预览和版本号。
- `POST /api/knowledge/import`：使用 `multipart/form-data` 上传 `files`，`mode` 可为 `append` 或 `replace`。
- `POST /api/knowledge/migrate-legacy`：管理员确认历史 revision 后，迁入为可见知识文件，原备份保留。
- `GET /api/knowledge/:id/download`：下载已保存原文件。
- `DELETE /api/knowledge/:id`：删除原文件及其全部片段。

### 主持控制接口

- `GET /api/live/state`：前台读取当前 `dialogue` / `hosting` 模式，不含主持词正文。
- `GET /api/live/events`：前台订阅 `sync`、`mode`、`present` 和 `stop` 事件；`present` 事件携带当次确定的主持词原文。
- `GET /api/live-control`：登录后读取主持词、revision、最近一次指令和已连接前台数量。
- `PUT /api/live-control`：登录后持久化整份主持词列表。
- `POST /api/live-control/mode`：登录后切换运行模式。
- `POST /api/live-control/present`：登录后按 `scriptId` 下发主持词。
- `POST /api/live-control/stop`：登录后停止所有已连接前台的当前播报。

### 运维日志接口

- `GET /api/ops-logs`：登录后查询结构化日志；支持 `limit`、`level`、`category`、`outcome` 和 `search`。
- `GET /api/ops-logs/download`：登录后下载当前保留范围内的 JSONL 日志。
- `POST /api/client-events`：访客前台上报固定格式的执行状态，只写入、不提供日志读取；后台按对话编号或主持指令号查询。

### 健康与就绪接口

- `GET /health` 始终返回 HTTP 200，用于读取 `ready`、内容版本以及模型的 `unconfigured`、`unverified`、`available` 或 `unavailable` 状态。
- 健康响应中的 `operations` 显示日志写入状态；日志暂时写入失败时整体状态会标记为 `degraded`，但不会中断已经可用的问答或主持链路。
- `GET /ready` 返回同一结构。对话模式下，只有内容可服务且模型已完整配置、未处于已知不可用状态时返回 HTTP 200；主持模式不依赖模型，因此内容和实时控制可用即可返回 HTTP 200。Docker 健康检查使用此接口。
- 内容文件损坏但仍有上一有效版本时，服务保持 `ready: true`，整体状态为 `degraded`；已知模型调用失败时则为 `ready: false` 和 `not_ready`。

## 后台访问保护

需要从校园网其他电脑或服务器访问时，只需开放监听地址：

```bash
HOST=0.0.0.0 npm start
```

第一次打开管理页时直接设置密码，之后使用该密码登录。首次设置、登录和登录后的全部管理接口均不校验页面来源。`ADMIN_PASSWORD` 仅作为可选的预设方式，不是远程访问的前置条件。管理密码与模型服务的 API Key 是两个独立凭据；如需给自动化程序另行授权，再单独设置 `ADMIN_API_KEY`。

正式对公网开放时，还应由现有网关提供 HTTPS、限流和适当的访问日志策略。

## 兼容 `content.json`

服务保留已有 `content.json` 和 `GET/PUT /api/content` 作为历史备份接口，但这些内容不参与回答。知识库列表下的“历史问答备份”可下载备份，或明确选择“迁入知识库”，生成可见的 `历史问答迁移.md` 文件；迁入去重，删除这个知识文件后旧内容不会悄悄恢复。原备份不会被迁移删除。历史文件默认每 2 秒检查一次：

- 新文件校验成功时，整份内容一次性切换。
- 新文件格式错误时，继续使用上一份有效内容，并把健康状态标记为 `degraded`。
- 文件修复后自动恢复为 `ready`。

每条历史内容仍需要唯一 `id`、非空 `questions`、非空 `keywords` 和 `answer`。格式异常不阻断文件知识问答，但会提示备份读取异常。

## 自动测试

```bash
npm test
```

测试覆盖管理会话、全文对话日志及脱敏、上游 401/429/500 分类、同义问法、历史内容迁入/删除、主持重连和过期状态、语音失败/静音/完成、断网兜底、文件导入持久化、模型配置与视频 Range。执行 `npm test` 查看当前数量；`test/avatar-runtime.test.js` 在隔离环境执行实际前台源码，覆盖之前纯接口测试未覆盖的异常分支。

核心问答功能用例和容量/稳定性用例可分别执行：

```bash
npm run test:functional
npm run test:capacity
```

并发阶梯、CPU/RSS 采样、稳定性浸泡和真实模型测试环境的用法见 [TESTING.md](TESTING.md)。容量测试不会被普通 `npm test` 自动执行。

## Docker 运行

```bash
docker build -t dafuture-answer-mvp .
docker volume create dafuture-answer-data
docker run --rm -p 8080:8080 \
  -v dafuture-answer-data:/data \
  dafuture-answer-mvp
```

启动后打开管理页设置密码。命名卷同时持久化人工知识、主持词、运维日志、模型配置、管理密码哈希、文件知识索引和原文件。不要把含真实 Key 或运行日志的卷导出到公开位置。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 本地监听地址；Docker 镜像设置为 `0.0.0.0` |
| `PORT` | `8080` | 监听端口 |
| `CONTENT_FILE` | 当前目录的 `content.json` | 内容文件；Docker 使用 `/data/content.json` |
| `MODEL_CONFIG_FILE` | 与内容文件同目录的 `model-config.json` | 模型私有配置；Docker 使用 `/data/model-config.json` |
| `KNOWLEDGE_FILE` | 与内容文件同目录的 `knowledge.json` | 已提取文字与分片索引 |
| `KNOWLEDGE_FILES_DIR` | 知识索引同目录的 `knowledge-files` | 已导入原文件目录 |
| `ADMIN_AUTH_FILE` | 与内容文件同目录的 `admin-auth.json` | 首次设置的管理密码加盐哈希 |
| `LIVE_CONTROL_FILE` | 与内容文件同目录的 `host-scripts.json` | 持久化主持词；运行模式和播报指令不落盘 |
| `OPS_LOG_FILE` | 与内容文件同目录的 `operations.jsonl` | 持久化结构化运维日志；Docker 使用 `/data/operations.jsonl` |
| `OPS_LOG_MAX_BYTES` | `5242880` | 单个日志文件最大字节数，范围 32768—104857600 |
| `OPS_LOG_MAX_FILES` | `3` | 包含当前文件在内的保留文件数，范围 1—10 |
| `ADMIN_PASSWORD` | 未设置 | 可选的 Web 管理页预设密码；不设置时由首次访问者在页面中创建 |
| `ADMIN_SESSION_TTL_MS` | `28800000` | 管理会话有效期，可设 15 分钟至 7 天 |
| `ADMIN_COOKIE_SECURE` | 自动 | HTTPS 网关后若服务无法识别原始协议，可显式设为 `true` |
| `CONTENT_POLL_INTERVAL_MS` | `2000` | 内容文件检查间隔，20—60000 毫秒 |
| `CORS_ORIGIN` | `*` | 允许调用问答接口的前台来源 |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |
| `ADMIN_API_KEY` | 未设置 | 可选的 Bearer API 密钥；未设 `ADMIN_PASSWORD` 时也作为 Web 登录密码 |
