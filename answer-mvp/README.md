[English](README.en.md)

# “大未来”大模型数字人问答 MVP

这是一个可运行的本地原型：访客在数字人前台提问，服务把问题与 `content.json` 中维护的业务知识交给后台配置的大语言模型，再将模型生成的文字用于页面显示和浏览器语音播报。

当前支持 OpenAI 兼容的 `/chat/completions` 接口。模型 API 地址、API Key、模型名、回答范围和系统提示词均可在 Web 工作台中配置。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm start
```

服务默认只监听本机 `http://127.0.0.1:8080`：

- `http://127.0.0.1:8080/`：内容与模型配置工作台。
- `http://127.0.0.1:8080/avatar`：面向访客的数字人问答前台。
- `http://127.0.0.1:8080/health`：服务、内容和模型配置状态。

首次启动时模型处于“等待配置”状态。打开工作台，点击“模型设置”，至少填写：

1. API 地址，例如服务商提供的 `https://服务地址/v1`。
2. API Key。
3. 模型名称，即服务商提供的模型 ID。

点击“保存设置”只保存配置；点击“保存并测试连接”会额外发起一次很短的真实模型请求，可能产生少量费用。

## 模型配置安全

模型设置写入独立的 `model-config.json`，不会写进 `content.json`：

- API Key 仅由服务端读取，`GET /api/model-config` 永不返回 Key 明文。
- 页面重新打开后只显示“服务器已保存”，Key 输入框保持空白。
- 留空保存会保留已有 Key；只有勾选“清除服务器上已保存的 API Key”才会删除。
- 文件以 `0600` 权限原子写入，并已加入 `.gitignore`。
- 仓库只提供不含真实 Key 的 `model-config.example.json`。

本机运行时的默认路径为 `answer-mvp/model-config.json`。Docker 中使用 `/data/model-config.json`。

## 回答范围

模型设置提供两种模式：

- `仅依据后台内容`：模型只能基于 `content.json` 回答；资料不足时返回“当前内容中暂无相关信息。”。
- `允许补充一般知识`：优先使用后台内容，可以补充通用知识，但不得编造本项目专属的日期、地点、费用、人员或规则。

无论选择哪种模式，`content.json` 都只是模型的知识上下文，不会再被接口直接当作最终答案返回。

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

## 数字人前台

前台使用四段预生成透明视频表现四种状态：

```text
页面打开 → idle
提交问题 → thinking
模型答案就绪 → speaking
语音结束 → idle
点击“主持开场” → presenting → 语音结束 → idle
```

当前播报使用浏览器本地语音合成。视频不可用或用户启用“减少动画”时，页面会降级为轻量动画，问答仍可使用。

手动预览四态：

```text
http://127.0.0.1:8080/avatar?preview=1
```

视频替换方法见 `public/avatar-media/README.md`；数字人名称、欢迎语、主持词、快捷问题和素材路径在 `public/avatar-config.json` 中配置。

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
  "answer": "模型结合后台内容生成的回答。",
  "speechText": "模型结合后台内容生成的回答。",
  "model": "已配置的模型 ID",
  "references": [
    { "id": "frontend-integration" }
  ]
}
```

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

- `GET /api/model-config`：读取非敏感设置和 `hasApiKey` 状态。
- `PUT /api/model-config`：保存设置；空 Key 保留旧值。
- `POST /api/model-config/test`：使用已保存设置发起一次连接测试。

模型接口与 `GET/PUT /api/content` 使用相同的后台访问保护。

## 后台访问保护

不设置 `ADMIN_API_KEY` 时，配置接口只接受本机同源页面访问。需要从校园网其他电脑或服务器访问时，应同时设置监听地址和足够长的随机管理密钥：

```bash
HOST=0.0.0.0 ADMIN_API_KEY='请替换为随机管理密钥' npm start
```

打开页面后点击“管理密钥”，输入相同内容即可。该管理密钥只保存在当前浏览器标签页的会话存储中。它与模型服务的 API Key 是两个独立凭据。

正式对公网开放时，还应由现有网关提供 HTTPS、限流和适当的访问日志策略。

## 修改 `content.json`

推荐在 Web 工作台中修改，也可以直接编辑文件。服务默认每 2 秒检查一次：

- 新文件校验成功时，整份内容一次性切换。
- 新文件格式错误时，继续使用上一份有效内容，并把健康状态标记为 `degraded`。
- 文件修复后自动恢复为 `ok`。

每条内容需要唯一 `id`、非空 `questions`、非空 `keywords` 和 `answer`。其中 `answer` 表示交给模型参考的已确认内容。

## 自动测试

```bash
npm test
```

测试覆盖模型配置的保存与清除、Key 不回显和文件权限、OpenAI 兼容请求结构、模型上下文、明确拒答、上游错误脱敏、配置接口鉴权、内容热加载、数字人状态机和视频 Range 请求。

## Docker 运行

```bash
docker build -t dafuture-answer-mvp .
docker volume create dafuture-answer-data
docker run --rm -p 8080:8080 \
  -e ADMIN_API_KEY='请替换为随机管理密钥' \
  -v dafuture-answer-data:/data \
  dafuture-answer-mvp
```

命名卷同时持久化 `/data/content.json` 和 `/data/model-config.json`。不要把含真实 Key 的卷导出到公开位置。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 本地监听地址；Docker 镜像设置为 `0.0.0.0` |
| `PORT` | `8080` | 监听端口 |
| `CONTENT_FILE` | 当前目录的 `content.json` | 内容文件；Docker 使用 `/data/content.json` |
| `MODEL_CONFIG_FILE` | 与内容文件同目录的 `model-config.json` | 模型私有配置；Docker 使用 `/data/model-config.json` |
| `CONTENT_POLL_INTERVAL_MS` | `2000` | 内容文件检查间隔，20—60000 毫秒 |
| `CORS_ORIGIN` | `*` | 允许调用问答接口的前台来源 |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |
| `ADMIN_API_KEY` | 未设置 | 后台配置接口的管理密钥；从非本机访问时必须设置 |
