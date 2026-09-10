[English](EXTERNAL_MODEL_INTEGRATION.en.md) · [返回项目说明](../README.md)

# “大未来”外部模型接入与 AI 开发交接说明

文档版本：1.0　核对日期：2026-09-10

代码基线：`8741f252538153bbe2e03544b8e48ac289623bad`，`package.json` 版本为 `0.8.0`。

> 本文是一份接入设计与开发交接文档，不代表外部语音已经实现。文中明确标为“建议新增”的接口、文件、配置和行为，需要开发后才能使用。不要仅把接口名称复制进配置就认为已经接通。未核验任何真实账号权限、Key、计费额度或线上部署。

## 1. 一分钟结论

- 已实现：后台配置大语言模型，通过 OpenAI 兼容的聊天接口生成文本回答。
- 尚未实现：服务端外部语音识别 ASR、外部语音合成 TTS、主持词预生成音频、音频持久化与缓存。
- 当前语音：前台调用浏览器识别和合成能力；已经预留替换入口，但只有 `browser` 实现。
- 推荐顺序：先接 TTS → 主持词预生成与试听 → 接 ASR → 再根据实测考虑流式语音和语义检索。
- 本轮不需要：实时口型模型、全双工语音助手、向量数据库、GPU 推理集群或新增微服务。
- 使用方式：仍在现有 Web 后台填写参数和测试，访客不需要配置任何 Key。

数字人画面目前是预制的无声视频与海报，不是实时生成视频，也没有逐字口型同步。语音模型负责“声音”，大语言模型负责“内容”，不要混为一个配置项。

## 2. 已实现与待开发边界

| 模块 | 基线中的真实实现 | 本文建议 |
| --- | --- | --- |
| LLM | `POST /answer` → 服务端 `/chat/completions` | 保留现有契约与自然兜底 |
| ASR | `SpeechRecognition` / `webkitSpeechRecognition` | 新增录音上传与服务端识别适配器 |
| TTS | `SpeechSynthesisUtterance` | 新增服务端合成、浏览器音频播放适配器 |
| 主持 | 后台选择原稿，通过 SSE 下发并由浏览器读出 | 生成音频、试听确认后再下发已确认音频 |
| 知识检索 | 小库在 24,000 字符预算内全量上下文；大库采用同义词与文本匹配 | 第一阶段不改检索，也不新增 Embedding |
| 日志 | 完整问答正文、对话编号、模型结果和前台播报事件 | 增加 ASR/TTS 阶段、供应商请求编号和缓存情况 |
| 数字人画面 | `idle`、`thinking`、`speaking`、`presenting` 四态视频 | 保留现有播放器及微信/手机适配 |

注意：当前 `server.js` 的部分版本标识仍为 `0.7.0`，与 `package.json` 的 `0.8.0` 不一致。核对实现应使用 Git 提交与实际代码，不要只凭 `/api` 的版本字符串判断能力；本文不修改该标识。

## 3. 推荐的接入结构

```text
对话模式
键盘输入 ──────────────────────────────┐
麦克风 → 浏览器采集 → 项目服务端 → ASR → 文本 ─┤
                                           ↓
                              现有 /answer + 知识库 + LLM
                                           ↓
                                     已校验的回答文本
                                           ↓
                              项目服务端 → TTS → 音频
                                           ↓
                            浏览器播放 + 数字人状态 + 日志

主持模式
已保存主持词 → 后台生成音频 → 试听确认 → 持久化
                                           ↓
                           后台点击 → SSE 指令 → 前台播放
```

浏览器只连接本项目服务端。服务端根据具体供应商协议调用 HTTP 或 WebSocket；现有 SSE 继续承担主持控制，不用于上传麦克风音频。项目自己的 HTTP 接口不意味着供应商也必须支持相同的 HTTP 接口。

建议第一阶段使用现有 Node.js/Fastify 进程内的适配器，不引入独立 Python 服务。选定供应商后，按其官方协议实现；不要为了沿用某个 SDK，未经评估就增加运行时和部署组件。

## 4. 给接手 AI 的代码地图

以下路径以 `answer-mvp/` 为起点，函数名比行号更稳定。

| 文件 | 已有入口 | 接入时的作用 |
| --- | --- | --- |
| [server.js](server.js) | `buildApp`、`ModelConfigStore`、`requireAdminAccess` | 注册新接口、配置存储、鉴权和错误处理；`ModelConfigStore` 在此文件内，不是独立文件 |
| [server.js](server.js) | `callLanguageModel`、`parseModelAnswer`、`buildModelMessages` | 保留 LLM 调用、JSON 校验、知识约束和兜底 |
| [public/avatar.js](public/avatar.js) | `BrowserVoiceInput`、`voiceInputProviders` | 新增录音与 ASR 输入实现 |
| [public/avatar.js](public/avatar.js) | `speechProviders`、`speakText`、`stopSpeech`、`finishSpeechSequence` | 新增服务端 TTS 音频播放实现 |
| [public/avatar.js](public/avatar.js) | `askQuestion`、`beginHostedPresentation`、`applyRemoteLiveState` | 串联问答、主持音频与取消控制 |
| [public/avatar-flow.js](public/avatar-flow.js) | `AvatarFlow`、`LiveStateTracker` | 保留请求/语音序号与服务实例排序规则 |
| [public/avatar-media.js](public/avatar-media.js) | 现有视频播放器 | 不因接语音而重写视频或移动端布局 |
| [public/avatar-config.json](public/avatar-config.json) | `speech`、`speechInput` | 公开的前台配置，禁止放 Key |
| [public/index.html](public/index.html)、[public/app.js](public/app.js) | 模型设置弹窗、主持控制、运维日志 | 新增紧凑的语音设置、测试及音频确认操作 |
| [live-control-store.js](live-control-store.js) | `LiveControlStore.present/stop/syncEvent` | 扩展音频引用，保留原文和指令序号 |
| [ops-log-store.js](ops-log-store.js) | `OpsLogStore` | 写入阶段诊断；不要另造一套不可关联的日志 |
| [knowledge-store.js](knowledge-store.js) | 导入、持久化、内置知识关联 | 本阶段保持不变，不能恢复隐藏知识 |
| [Dockerfile](Dockerfile) | 显式 `COPY` 服务端文件 | 新文件必须加入复制清单，否则容器无法运行 |

建议新增文件，当前不存在：

```text
speech-config-store.js          私有语音配置、校验、原子保存
speech-service.js               统一 ASR/TTS 调用、错误、取消与日志
speech-providers/bailian.js     第一家供应商适配器，名称随实际选型确定
speech-audio-store.js           主持音频、临时音频与缓存索引
speech-config.example.json     不含真实凭据的配置示例
test/speech.test.js             模拟供应商与接口测试
```

这些模块可以按实现规模合并，但不要复制整套问答或主持逻辑。

## 5. LLM：现有契约必须保留

管理员入口为“大语言模型设置”：填写 API 地址、Key、模型名、回答范围、风格和两类兜底话术。相关接口已存在：

- `GET/PUT /api/model-config`
- `POST /api/model-config/test`
- `POST /answer`

访客请求示例：

```http
POST /answer
Content-Type: application/json
X-Conversation-Id: 45a07063-bc3f-47e6-950b-15955a0f5e90

{"question":"怎样参加项目？"}
```

模型原始回答应为 `{"status":"answered","answer":"…"}` 或 `{"status":"no_answer","answer":""}`。项目对外返回 `answer`、`speechText`、`answered`、`answerStatus`、`answerStatusSource`、`turnId`、`requestId` 及检索信息。`no_answer` 使用管理员配置的知识不足话术；服务异常保留非 2xx 状态并返回自然兜底。

TTS 必须消费服务端已经校验的最终 `speechText`，包括正常回答和系统兜底；不能直接读取供应商原始 JSON、推理内容、工具调用或截断输出。不要为了“降低延迟”跳过完整 JSON 校验而提前播报模型片段。

不同厂商的模型参数兼容程度不同。第一次接某个 LLM 时，确认认证方式、完整 URL、模型 ID、非流式文本响应、输出长度参数和结构化回答能被现有解析器接受。不支持该聊天协议的模型需要服务端适配器，不能只换模型名。

## 6. 语音配置：建议新增

在现有模型设置中增加“大语言模型 / 语音合成 / 语音识别”三个设置页签，保留工作台原来的“对话 / 主持”两个业务模式，不新增占空间的大标题。

| 设置 | 最少字段 | 操作 |
| --- | --- | --- |
| TTS | 浏览器/服务端、供应商、地域、必要的业务空间、地址、Key、模型、音色、语速 | 保存并测试、试听、停止试听 |
| ASR | 浏览器/服务端、供应商、地域、必要的业务空间、地址、Key、模型、语言 | 保存并测试、录音测试；热词可放高级设置 |

建议以独立 `speech-config.json` 持久化，不改写现有 `model-config.json`。以下只是私有配置结构示例，空字段并不能启用外部服务：

```json
{
  "version": 1,
  "tts": {
    "provider": "browser",
    "endpoint": "",
    "region": "",
    "workspaceId": "",
    "apiKey": "",
    "model": "",
    "voice": "",
    "rate": 1,
    "format": "mp3",
    "timeoutMs": 30000
  },
  "asr": {
    "provider": "browser",
    "endpoint": "",
    "region": "",
    "workspaceId": "",
    "apiKey": "",
    "model": "",
    "language": "zh-CN",
    "timeoutMs": 30000
  }
}
```

设计要求：

- 默认继续使用 `browser`；未配置语音服务时，不能阻断现有文字问答或管理登录。
- `provider` 只能选已经实现的适配器；外部模式缺字段或名称不支持时明确报错，不能假装外部已生效。
- 每一项服务可有独立 Key。即便使用同一个平台，也不要默认模型权限、地域、音色或 Key 能跨服务通用。
- Key 留空保留原值，清除使用明确的 `clearApiKey` 操作；GET 只返回 `hasApiKey`，不返回明文。
- 私有文件以 `0600` 权限原子写入；并发保存通过 `revision` 检查，失败保留旧有效配置。
- 供应商、Key、地址或模型变更，由管理员明确点击“保存并测试”进行短测试后激活；只改界面、重新打开页面或刷新健康状态，不能偷偷触发付费调用。
- `GET /avatar-config.json` 只下发 `browser/server` 选择、前台所需的非敏感参数及兜底音频引用；不下发供应商 Key。前台 `server` 与服务端供应商名称是两层概念。

百炼可作为第一家候选：其 ASR 有 HTTP 文件识别和 WebSocket 实时识别；TTS 可按场景选择 Qwen-TTS 或 CosyVoice。先选定一个具体模型/地域/音色组合并试听，按对应官方协议实现，不照抄聊天 URL。型号与能力会变化，开发当天应重新核对。[ASR 官方选型](https://help.aliyun.com/zh/model-studio/asr-model/) · [TTS 官方选型](https://help.aliyun.com/zh/model-studio/tts-model/)

## 7. 项目接口契约：全部为建议新增

下面是本项目的适配层接口，不是供应商原生接口。路径可在实现前调整，但前后端、测试和文档必须一致。

| 方法与路径 | 调用方/权限 | 作用 |
| --- | --- | --- |
| `GET/PUT /api/speech-config` | 管理员 | 读取脱敏配置、保存并验证候选配置 |
| `POST /api/speech/test` | 管理员 | 测试指定 `tts/asr` 配置；不得隐式改写有效配置 |
| `POST /api/speech/transcribe` | 访客 | 上传一轮录音，返回文字，不在此接口自动调用 LLM |
| `POST /api/speech/synthesize` | 访客 | 根据已生成回答的 `turnId` 获取音频 |
| `GET /api/speech/audio/:audioId` | 持有音频引用的前台 | 获取已准备的音频，不能读取任意服务器路径 |
| `POST /api/live-control/scripts/:id/audio` | 管理员 | 生成指定已保存主持词的音频 |
| `PUT /api/live-control/scripts/:id/audio` | 管理员 | 确认试听通过的音频版本 |

### 7.1 配置与测试

`PUT /api/speech-config` 建议接收 `{revision, tts, asr, testConnection}`；支持只更新其中一个子项，未提交的字段保持不变。测试失败不能激活候选配置。返回脱敏的配置、最新 `revision` 与两个服务各自的测试状态。

`POST /api/speech/test` 接收 `{kind:"tts", text:"您好，欢迎体验。"}`，返回短时试听音频引用及诊断编号；ASR 测试使用 multipart 录音上传，通过现有管理员会话识别为测试。用于测试的任意文本/录音能力只向管理员开放。测试消耗供应商额度，界面需要明确说明。

### 7.2 ASR 录音转文字

请求：`multipart/form-data`，一个 `audio` 文件，加 `turnId`、`requestId` 两个字符串字段。ID 使用 UUID；不要手工设置 multipart 边界，由浏览器 `FormData` 生成。

第一阶段建议统一为 WAV、16 kHz、单声道、16-bit PCM，最长 60 秒、文件上限 2 MiB。这是项目建议值，不是所有供应商的通用规格；选型后可调整。按路由覆盖 Fastify/multipart 限制，不能只改全局 JSON `bodyLimit`。检查实际音频头、时长和格式，不能仅信扩展名或客户端 MIME。

```json
{
  "turnId": "45a07063-bc3f-47e6-950b-15955a0f5e90",
  "requestId": "1b3348f1-d79f-4e03-9cf8-1d65d5d2efaa",
  "text": "怎样参加项目？",
  "language": "zh-CN",
  "durationMs": 3200
}
```

响应中的 `durationMs` 指输入音频时长；调用耗时单独写入日志。只接受最终转写文本，临时结果不触发 `/answer`。静音/空结果返回 `ASR_NO_SPEECH`，不调用 LLM。超过现有问题长度上限的文本交给用户编辑，不静默截断后提交。

### 7.3 TTS 回答转音频

```http
POST /api/speech/synthesize
Content-Type: application/json

{"turnId":"45a07063-bc3f-47e6-950b-15955a0f5e90","requestId":"aa1b5e3f-5c2d-43a9-ae77-15257b0ce06c"}
```

服务端需要新增有容量和 TTL 限制的“最近回答”存储，例如最多 200 轮、10 分钟：在 `/answer` 最终响应阶段保存正常答案及系统兜底对应的 `speechText`，再由 `turnId` 查找。访客不能传入任意待合成文本、供应商地址、Key 或本地文件路径。ID 不是管理员认证凭据，不能用它访问配置或日志；重复/冲突的对话 ID 需检测并避免覆盖其他轮次。

成功返回实际音频二进制，例如 `Content-Type: audio/mpeg`，以及 `X-Speech-Request-Id`、`X-Cache-Hit`。跨来源前端如需读取自定义头，要配置对应的 CORS 暴露头。失败返回非 2xx JSON：

```json
{
  "error": "TTS_TIMEOUT",
  "message": "语音暂时不可用，请阅读屏幕上的回答。",
  "turnId": "45a07063-bc3f-47e6-950b-15955a0f5e90",
  "requestId": "aa1b5e3f-5c2d-43a9-ae77-15257b0ce06c",
  "retryable": true
}
```

过期或未知的轮次返回 `404 SPEECH_TURN_EXPIRED`，不能因此重新调用 LLM，也不能播报供应商错误正文。返回的音频应验证类型、非空、大小和可解码性；上游返回 HTTP 200 的 HTML/JSON 仍是失败。

### 7.4 音频引用与主持音频

生成主持音频请求使用 `{revision}`，服务端根据脚本 ID 读取已保存的原文；返回 `{audioId, previewUrl, cacheKey, status:"prepared"}`。试听确认请求使用 `{revision, audioId, approved:true}`；必须确认音频仍匹配当前文稿及音色设置。

`audioId` 应不可预测，映射由服务端维护；只公开确需前台播放的资源，不提供目录列表或任意文件下载。对话/测试音频设置短期保留，已确认主持音频单独持久化。该 Demo 的现场播放资源不是严格保密分发；若后来要求音频访问控制，应作为新需求设计。

音频读取应提供正确的 MIME 与长度，并支持 `HEAD` 和合法的 `Range` 请求；可参考已有视频路由的范围读取逻辑，但只能读取音频索引内的受控资源。将手机音频加载与拖动/重播纳入验收。

## 8. 供应商适配器与音频格式

建议统一内部接口，使供应商协议与 UI 隔离：

```js
// 接口示意，不是可直接运行的实现。
transcribe({ audioBuffer, mimeType, language, signal, requestId });
// Promise<{ text, providerRequestId, audioDurationMs }>

synthesize({ text, voice, rate, format, signal, requestId });
// Promise<{ audioBuffer, mimeType, providerRequestId }>
```

- 第一阶段浏览器与本项目之间走普通 HTTP。供应商适配器可以在内部使用 HTTP、任务轮询或 WebSocket，但必须覆盖超时、取消和连接释放。
- 如需增加 WebSocket、音频编码或供应商 SDK 依赖，同步更新 `package.json` 与锁文件，并验证项目声明的 Node.js 版本范围；不要假设某个浏览器 API 在服务端也可用。
- 如供应商先返回异步任务 ID，要等待任务最终成功，不能把“已受理”当成“已合成/已识别”。首版优先选适合短句交互的服务。
- 不能默认浏览器 `MediaRecorder` 输出 WAV。若选择 WAV 方案，应明确实现采集、重采样和编码；若选 WebM/Opus，必须确认供应商接受或明确增加转码组件。
- TTS 优先选择浏览器可直接播放的封装格式；裸 PCM 不是 MP3/WAV，不得只改文件扩展名后交给 `<audio>`。
- 模型允许的最大文本长度、音频规格、音色与模型版本匹配，均在适配器内校验。超长主持词可分段合成，但必须全部成功并试听确认，不能以截断音频冒充完整稿件。
- 使用供应商系统音色先完成闭环；声音复刻、声音设计、实时语音对话和口型驱动均不属于首阶段默认范围。

## 9. 前台播放、取消与主持确定性

新增 `speechProviders.server` 与 `voiceInputProviders.server`，复用现有入口，不写第二套聊天状态机。

### 对话音频

1. 保留 `askQuestion` → `answerReady` 的流程；拿到答案后仍处于 `thinking/audio-preparing`。
2. 以该轮 `turnId` 请求 TTS，生成 Blob URL 或受控音频引用。
3. 只有 `<audio>` 的 `playing` 事件才能调用 `startSpeechSequence`；返回文本、获取音频字节、`canplay` 都不等于已经发声。
4. `ended` 才表示正常完成。`play()` 被拒绝、解码失败、超时和网络失败分别进入失败/等待用户操作状态，不能显示“播报完成”。浏览器可能拒绝脚本触发的播放，需要保留点击播放入口。[播放规则](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)

### 取消必须覆盖整条链路

- 新问题、主持新指令、停止、切换模式、静音及控制断线，继续沿用现有取消语义。
- 除了 `speechSynthesis.cancel()`，还要取消当前音频请求、停止 `<audio>`、清空待播放队列、释放 Blob URL；ASR 取消时停止麦克风轨道。
- 以 `speechSequence`、`requestSequence` 和主持的 `instanceId + commandSequence` 丢弃晚到结果。即便供应商无法真正中止计算，旧结果也绝不能再次播放。
- 外部 TTS 的合成超时与浏览器音频启动超时分开计算；不能把当前浏览器语音的 8 秒启动计时直接覆盖整个云端合成过程。
- 后端尽力取消上游调用；客户端停止并不必然撤销已经产生的供应商费用，不承诺零计费。

### 主持音频的明确策略

- 在“预生成音频模式”下，流程为保存原稿 → 生成音频 → 试听 → 确认 → 播放。
- 复用现有主持 `present` 事件，增加可选 `audio: {id, url, mimeType, cacheKey}`，原有 `script`、`instanceId`、`sequence`、`commandSequence` 必须保留。
- `cacheKey` 至少包含原文、供应商、模型、音色、语速、格式以及影响输出的其他参数。正文或声音配置变更后，旧音频不得继续标为已确认。
- 预生成模式下音频未准备/未确认时返回 `409 HOST_AUDIO_NOT_READY`，不下发新的播报指令；仍可显式选择原有浏览器模式。
- 主持音频生成只在管理员端发生，避免每个现场前台重复合成。现场点击使用已确认音频，不能让 LLM 改写主持词，也不临时换音色重合成。
- `sync` 和重连仅同步控制状态，不自动重播已结束或旧指令。停止和较新指令继续优先于音频下载完成回调。
- 音频预加载不代表允许离线接受新指令；现有控制断线暂停策略保持不变，不因本地有缓存就绕过。

## 10. 语音输入与自然兜底

第一阶段只做“一次说完，再识别”，不默认实现持续监听、唤醒词、回声消除或边播边打断。按下麦克风时停止当前播报，识别最终文字后复用现有提交流程，保留键盘输入。

在录音开始时生成 `turnId`，ASR、`/answer`、TTS 和播报日志沿用同一个编号。当前 `askQuestion` 会自行生成编号，需要允许传入已有编号；不要在每个阶段重新编号导致日志断链。

远程网页录音需要 HTTPS 和用户授权，这是浏览器要求，不是项目新增的来源限制；本地 `localhost` 是开发例外。微信还需目标手机实测。[麦克风要求](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

兜底顺序建议：

| 失败位置 | 应有行为 |
| --- | --- |
| ASR 失败或无语音 | 不调用 LLM；提示重说或改为打字 |
| LLM 无依据 | 保留现有知识不足话术，允许正常合成与播报 |
| LLM/网络异常 | 使用现有自然服务异常话术；不能播技术错误 |
| TTS 失败但答案有效 | 保留答案文字；可尝试浏览器语音，仍失败则明确“语音未能播放” |
| 前台至服务端断网 | 使用页面已缓存的兜底音频；没有音频则保留文字并如实提示 |
| 主持音频损坏/不可用 | 明确失败，等待后台重试；不改写或自动换稿 |

建议预生成服务异常、知识不足、未听清等短音频，并在前台加载后预取。最低阶段的缓存只保证当前已打开页面使用；若要求刷新后仍可离线播报，需要另加并验收 Cache Storage/Service Worker。浏览器语音不能被当成必然可离线的兜底。[浏览器识别边界](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)

## 11. 日志、错误与隐私

保留用户已要求的完整提问与回答，仅后台可查询、搜索和下载。增加阶段日志，但默认不永久保存原始麦克风录音。

建议诊断字段：`turnId`、项目 `requestId`、`providerRequestId`、`stage`、供应商、模型、音色、`durationMs`、`upstreamStatus`、`errorCode`、`cacheHit`、`outcome`。服务端日志中的 `durationMs` 表示该阶段耗时，音频时长另用 `audioDurationMs`。不得记录 Key、认证头、带临时签名的完整 URL 或原始上游敏感正文；扩展现有脱敏逻辑以覆盖新增语音 Key。

| 建议错误码 | 项目 HTTP 状态 | 说明 |
| --- | --- | --- |
| `ASR_NOT_CONFIGURED` / `TTS_NOT_CONFIGURED` | 503 | 服务未配置 |
| `ASR_INVALID_AUDIO` / `ASR_NO_SPEECH` | 400 / 422 | 无效音频或没有可用识别文字 |
| `ASR_AUDIO_TOO_LARGE` / `ASR_AUDIO_TOO_LONG` | 413 / 422 | 超出项目录音边界 |
| `ASR_TIMEOUT` / `TTS_TIMEOUT` | 504 | 超时 |
| `ASR_UPSTREAM_ERROR` / `TTS_UPSTREAM_ERROR` | 502 | 保留上游真实 401/403/429/5xx 到后台日志 |
| `TTS_INVALID_AUDIO` | 502 | 空音频、错误格式或不可解码 |
| `SPEECH_TURN_EXPIRED` | 404 | 本轮可合成内容已过期，不能重新请求 LLM |
| `HOST_AUDIO_NOT_READY` | 409 | 主持音频未准备或版本不匹配 |

当前 `/api/client-events` 严格校验字段与阶段，不能直接发送任意 `asr-*` 名称或音频正文。若增加 `asr-started/completed/failed/cancelled`，必须同步服务端阶段白名单、中文摘要、结果分类、前台发送和测试；沿用 `kind:"dialogue"` 及本轮 `turnId`。现有 `speech-*` 阶段继续用于最终播放结果。

缓存命中不等于播报完成，供应商成功不等于扬声器有声音。若云端 TTS 失败后浏览器兜底播放成功，应同时保留供应商失败和最终播放成功，不覆盖前一个事实。离线日志补传仍有现有的队列容量与标签页生命周期边界。

## 12. 存储、Docker 与兼容边界

建议新增环境变量 `SPEECH_CONFIG_FILE`、`SPEECH_AUDIO_DIR`；本机分别指向应用私有配置和音频目录，Docker 分别为 `/data/speech-config.json`、`/data/speech-audio`。在音频目录内保存索引与已确认音频，临时文件有容量、TTL 和清理策略，不能无限累积。

实施时必须同步：

1. 根目录 `.gitignore`：忽略私有语音配置、生成音频、缓存、测试录音与索引。
2. `answer-mvp/.dockerignore`：排除本机语音配置和生成物；示例配置保持无凭据。
3. `answer-mvp/Dockerfile`：显式复制新增服务端模块/供应商目录，配置 `/data` 路径与 `node` 用户写权限。
4. `compose.yaml`：复用现有 `answer-data:/data`，不要新建会丢失现有业务数据的数据位置。
5. 若拆出新的前端 JS 文件，必须在 `buildApp` 中加载并注册静态路由。当前服务不是自动暴露整个 `public` 目录，且部分静态内容在启动时读入，修改后需重启验收实例。
6. `/health` 可新增 ASR/TTS 配置与连接状态，但健康查询不产生付费调用；`/ready` 不应因可选语音未配置而判定文字问答不可用。

管理配置/测试/生成主持音频继续使用现有管理鉴权。访客识别、当前回答合成和播放沿用公开前台定位；不擅自恢复已被用户撤除的同源来源拦截，也不增加首次密码的本机限定。音频大小/时长、错误处理和必要费用边界应明确，不伪装成已经被用户批准的生产安全改造。

## 13. 推荐实施顺序与验收

### 分阶段交付

1. 基线检查：读本文和实际代码，核对分支、脏文件与已有配置，运行现有测试。
2. TTS：先完成模拟适配器、私有配置、后台试听、服务端合成与可取消的前台播放，再选择一个真实供应商适配器。
3. 主持音频：持久化、试听确认、版本失效、SSE 音频引用、停止和重连测试。
4. ASR：短录音、最终文本、同轮 ID、自动提交与文字回退。
5. 完整链路：错误分类、缓存、离线兜底、日志查看、Docker 与真机验收。

每一步都应保持旧 `browser` 模式可用，不先做一个覆盖所有供应商的大框架。Embedding、Rerank 和实时口型需要另行确定范围，不附带实现。

### 验收矩阵

| 场景 | 必须验证的结果 |
| --- | --- |
| 原有功能 | 当前全部测试通过，知识库、内置知识导入、LLM、主持、手机布局不回归 |
| 配置 | Key 不回显、不入日志；重启保留；错误候选不替换有效配置 |
| TTS 正常 | 音频可解码，实际 `playing` 后才切换说话姿态，`ended` 后回待机 |
| TTS 异常 | 401、403、429、5xx、超时、空音频、伪音频均可诊断且不误报完成 |
| 中断竞态 | 合成中停止、下载中换稿、播放中换模式，晚到音频都不能抢播 |
| 主持 | 点击使用已确认原文音频；修改文稿/音色使确认失效；多个前台不重复合成 |
| 重连 | 漏掉停止后可同步；旧实例/旧序号被拒绝；不自动重播 |
| ASR | 普通话与项目名测试；静音、超时、取消、无权限、格式不符均有自然提示 |
| 对话关联 | 一次录音从 ASR 到回答、TTS、播放使用同一个 `turnId` |
| 兜底 | 知识不足、LLM 故障、TTS 故障、前台断网分别走正确路径 |
| 日志 | 完整问答仅管理员可读；阶段耗时与上游故障可区分；敏感字段不泄露 |
| Docker | 新模块进入镜像；空卷和已有数据卷均可启动；重启保留配置及主持音频 |
| 真机 | 目标电脑/手机/微信中检查首次授权、点击播放、停止、静音及前后台切换 |

从仓库根目录开始的现有命令：

```bash
cd answer-mvp
npm ci
npm test
npm run test:functional
```

容器验收应使用独立测试项目/数据卷，不能直接用默认 Compose 项目覆盖正在使用的实例。测试里的模型、录音、知识与凭据全部用隔离夹具；真实供应商测试只有在用户配置并授权后执行。

交付报告必须分开写：模拟接口通过、真实供应商调用通过、真实浏览器播放通过、实际扬声器/目标手机通过。缺少哪一级就写未验证，不能用模拟成功代替真人现场效果或承诺延迟。

## 14. 可直接交给其他 AI 的任务说明

```text
请在“大未来数字人”现有仓库中，依据 answer-mvp/EXTERNAL_MODEL_INTEGRATION.md
接入外部语音能力。先检查当前代码和 Git 状态，不假定文档基线就是最新版本。

第一阶段仅做 TTS、主持词预生成音频与 ASR；保留现有 LLM /answer、知识库、
对话/主持模式、视频播放器、自然兜底和完整问答日志，不重写整个应用。

后台需要语音配置、保存并测试、试听；Key 仅存服务端且不回显。
前台需要可取消的音频播放和录音输入。沿用现有序号和实例排序，保证停止、
切模式、新主持指令后，晚到音频绝不抢播。主持使用试听确认的原稿音频。

本文标为建议新增的接口/文件尚不存在，需要实际实现。供应商协议、音色和
地域必须按开发当天的官方文档核对；不能把 ASR/TTS 只当成另一个聊天模型名。
新增服务端模块必须加入 Dockerfile，私有配置和音频目录挂载到现有 /data。

先用隔离模拟服务完成自动测试，再用用户明确配置且授权的供应商做短测试。
没有真实配置时仍完成可运行实现与模拟测试，并明确列出未验证部分；不索要
用户把真实 Key 发到聊天中，不擅自调用付费服务，不修改正式业务数据。
没有新要求时不加向量数据库、实时口型、全双工对话或来源访问限制。

交付代码、中文/英文分开的文档、测试结果、未完成项与本地运行方式。
只有用户明确要求时，才提交/推送 GitHub 或更新线上部署。
```

## 15. 官方资料与后续核对

下列资料核对日为 2026-09-10；它们描述供应商/浏览器能力，不是本项目已接入的证明。

- [百炼语音识别选型与规格](https://help.aliyun.com/zh/model-studio/asr-model/)
- [百炼语音合成选型与规格](https://help.aliyun.com/zh/model-studio/tts-model/)
- [百炼非实时语音合成](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)
- [百炼实时语音合成](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)
- [浏览器麦克风访问](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [浏览器语音识别兼容边界](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)
- [浏览器音频播放与拒绝处理](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)

模型 ID、地域 URL、业务空间参数、音色名称、费用和配额不在本文硬编码为通用默认值。实施时将实际选定组合及真实测试日期补入文档，仍不要记录真实 Key。
