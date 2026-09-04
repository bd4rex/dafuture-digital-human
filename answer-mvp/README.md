[English](README.en.md)

# “大未来”大模型数字人问答 MVP

这是一个可运行的本地原型：访客在数字人前台提问，服务把问题与手工问答、外部文件知识库交给后台配置的大语言模型，再将模型生成的文字用于页面显示和浏览器语音播报。

当前支持 OpenAI 兼容的 `/chat/completions` 接口。模型 API 地址、API Key、模型名、回答范围和系统提示词均可在 Web 工作台中配置。

## 本地运行

需要 Node.js 20.16—20.x，或 Node.js 22.3 及更高版本。

```bash
npm install
npm start
```

服务默认只监听本机 `http://127.0.0.1:8080`。首次打开管理页时需要设置一个至少 8 位的管理密码：

- `http://127.0.0.1:8080/`：内容与模型配置工作台。
- `http://127.0.0.1:8080/avatar`：面向访客的数字人问答前台。
- `http://127.0.0.1:8080/health`：服务诊断、内容版本和模型连接状态（始终返回 HTTP 200）。
- `http://127.0.0.1:8080/ready`：问答就绪检查；不可用时返回 HTTP 503。

## 管理员登录

- 未登录时，管理地址只显示密码页；手工内容、知识库和模型配置接口同时由服务端拦截。
- 没有预设密码时，首次访问管理页即可直接设置密码，本机、局域网或 Docker 访问方式一致。
- 密码只以 scrypt 加盐哈希保存到 `admin-auth.json`，文件权限为 `0600`，不保存明文。
- 登录后使用 HttpOnly、SameSite=Strict 会话 Cookie，默认 8 小时过期；服务重启或点击“退出登录”后会话失效。
- `ADMIN_API_KEY` 仍可作为 Bearer 密钥供自动化客户端调用；未单独设置 `ADMIN_PASSWORD` 时，它也是 Web 登录密码。

首次启动时模型处于“等待配置”状态。打开工作台，点击“模型设置”，至少填写：

1. API 地址，例如服务商提供的 `https://服务地址/v1`。
2. API Key。
3. 模型名称，即服务商提供的模型 ID。

点击“保存并测试连接”会先用候选配置发起一次很短的真实模型请求，验证成功后才落盘并切换。通过“保存设置”修改 API 地址、Key 或模型名时也采用同一保护；只调整回答范围、参数或提示词时不会重复测试。模型请求可能产生少量费用。

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

- `仅依据后台内容`：模型只能基于手工问答与已导入知识文件回答；资料不足时返回“当前内容中暂无相关信息。”。
- `允许补充一般知识`：优先使用后台内容，可以补充通用知识，但不得编造本项目专属的日期、地点、费用、人员或规则。

无论选择哪种模式，手工问答和已导入知识文件都只是模型的知识上下文，不会被接口直接当作最终答案返回。

## Web 工作台

内容区支持：

- 新增、编辑、复制、排序、删除和搜索知识条目。
- 为每条内容填写多种用户问法、关键词和已确认内容。
- 保存整份 `content.json`，让后续模型回答立即使用新版本。
- 校验必填项、重复内容 ID 和重复问法。
- 使用 revision 与磁盘哈希阻止并发修改被静默覆盖。
- 在右侧直接调用当前模型测试问答。

模型区支持：

- 配置 OpenAI 兼容 API 地址、API Key 与模型名称。
- 切换回答范围，设置随机度、最大输出 Tokens 和超时。
- 编辑系统提示词。
- 主动测试模型连接。

### 外部文件知识库

点击顶部“知识库”可以：

- 导入 UTF-8 编码的 TXT、Markdown、CSV、JSON，以及 DOCX 和含文本层的 PDF。扫描 PDF 需要先做 OCR。
- 在提交前预览文件名、大小和导入方式；每次最多 10 个文件，单个最大 10 MB，合计最大 30 MB。
- 选择“追加”保留现有文件，相同 SHA-256 内容会自动跳过；选择“替换”则只保留本次文件。
- 查看提取预览、下载原文件，或删除单个文件。
- 原文件保存在 `knowledge-files/`，提取文字和分片索引保存在 `knowledge.json`；两者都会随 Docker `/data` 卷持久化。

问答时服务会根据问题检索相关文件片段，最多取 12 个并受总上下文长度限制。文件名只在管理页显示，不会作为访客端的“资料来源”展示。

## 数字人前台

前台使用四段预生成透明视频表现四种状态：

```text
页面打开 → idle
提交问题 → thinking
模型答案就绪 → speaking
语音结束 → idle
点击“主持开场” → presenting → 语音结束 → idle
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

视频替换方法见 `public/avatar-media/README.md`；数字人名称、欢迎语、主持词和素材路径在 `public/avatar-config.json` 中配置。访客快捷问题统一取自 `content.json` 排名前三条内容的第一种问法；在工作台调整内容或顺序后，访客页会按内容版本自动刷新。

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

`answerStatus` 是回答/拒答的主状态，`answered` 仅为兼容旧前端的布尔值。服务优先读取模型返回的结构化状态；不支持结构化输出的兼容服务会标记 `answerStatusSource: "inferred"` 并使用稳健的拒答识别。`knowledgeContext.contextIds` 表示实际发送给模型的内容条目，`matchedIds` 表示服务端启发式匹配到的条目；两者都不声称模型在答案中引用或实际采用了某一条内容。

模型未配置时返回 HTTP `503`：

```json
{
  "error": "MODEL_NOT_CONFIGURED",
  "answered": false,
  "answer": "大语言模型尚未配置，请先在后台完成 API 设置。",
  "speechText": "大语言模型尚未配置，请先在后台完成 API 设置。",
  "message": "大语言模型尚未配置，请先在后台完成 API 设置。"
}
```

问题最多 500 个字符。联调环境可用 `CORS_ORIGIN` 限定允许调用的前台域名。

### 模型配置接口

- `GET /api/model-config`：读取非敏感设置、`hasApiKey` 和最近一次连接状态。
- `PUT /api/model-config`：保存设置；空 Key 保留旧值。完整连接字段发生变化时先验证后切换，也可显式发送 `testConnection: true`。
- `POST /api/model-config/test`：使用已保存设置发起一次连接测试。

模型接口、`GET/PUT /api/content` 与知识库接口使用相同的后台登录保护。

### 知识库接口

- `GET /api/knowledge`：读取已导入文件摘要、提取预览和版本号。
- `POST /api/knowledge/import`：使用 `multipart/form-data` 上传 `files`，`mode` 可为 `append` 或 `replace`。
- `GET /api/knowledge/:id/download`：下载已保存原文件。
- `DELETE /api/knowledge/:id`：删除原文件及其全部片段。

### 健康与就绪接口

- `GET /health` 始终返回 HTTP 200，用于读取 `ready`、内容版本以及模型的 `unconfigured`、`unverified`、`available` 或 `unavailable` 状态。
- `GET /ready` 返回同一结构；只有内容可服务且模型已完整配置、未处于已知不可用状态时返回 HTTP 200，否则返回 HTTP 503。Docker 健康检查使用此接口。
- 内容文件损坏但仍有上一有效版本时，服务保持 `ready: true`，整体状态为 `degraded`；已知模型调用失败时则为 `ready: false` 和 `not_ready`。

## 后台访问保护

需要从校园网其他电脑或服务器访问时，只需开放监听地址：

```bash
HOST=0.0.0.0 npm start
```

第一次打开管理页时直接设置密码，之后使用该密码登录。`ADMIN_PASSWORD` 仅作为可选的预设方式，不是远程访问的前置条件。管理密码与模型服务的 API Key 是两个独立凭据；如需给自动化程序另行授权，再单独设置 `ADMIN_API_KEY`。

正式对公网开放时，还应由现有网关提供 HTTPS、限流和适当的访问日志策略。

## 修改 `content.json`

推荐在 Web 工作台中修改，也可以直接编辑文件。服务默认每 2 秒检查一次：

- 新文件校验成功时，整份内容一次性切换。
- 新文件格式错误时，继续使用上一份有效内容，并把健康状态标记为 `degraded`。
- 文件修复后自动恢复为 `ready`。

每条内容需要唯一 `id`、非空 `questions`、非空 `keywords` 和 `answer`。其中 `answer` 表示交给模型参考的已确认内容。

## 自动测试

```bash
npm test
```

当前 32 项测试覆盖管理密码首次设置、登录与退出、加盐哈希和同源保护、知识文件导入/去重/替换/删除、重启恢复、DOCX/PDF 文字提取、知识上下文检索、候选模型配置失败回滚、Key 不回显、上游错误脱敏、内容热加载、数字人状态机和视频 Range 请求。

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

启动后打开管理页设置密码。命名卷同时持久化手工内容、模型配置、管理密码哈希、知识索引和原文件。不要把含真实 Key 的卷导出到公开位置。

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
| `ADMIN_PASSWORD` | 未设置 | 可选的 Web 管理页预设密码；不设置时由首次访问者在页面中创建 |
| `ADMIN_SESSION_TTL_MS` | `28800000` | 管理会话有效期，可设 15 分钟至 7 天 |
| `ADMIN_COOKIE_SECURE` | 自动 | HTTPS 网关后若服务无法识别原始协议，可显式设为 `true` |
| `CONTENT_POLL_INTERVAL_MS` | `2000` | 内容文件检查间隔，20—60000 毫秒 |
| `CORS_ORIGIN` | `*` | 允许调用问答接口的前台来源 |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |
| `ADMIN_API_KEY` | 未设置 | 可选的 Bearer API 密钥；未设 `ADMIN_PASSWORD` 时也作为 Web 登录密码 |
