[English](README.en.md)

# “大未来”大模型数字人问答 MVP

这是一个可在本地运行的数字人问答原型。内容人员通过 Web 工作台维护业务知识和模型设置，访客通过数字人前台提问，服务调用 OpenAI 兼容的大语言模型生成回答，并由浏览器完成语音播报和数字人状态切换。

## 当前状态

- 应用版本：`0.3.0`。
- 已实现密码保护的内容工作台、持久化外部文件知识库、模型配置、问答接口、四态透明视频前台、浏览器普通话语音提问和男声播报。
- 模型 API Key 仅保存在被 Git 忽略的服务端配置文件中，接口和页面均不回显明文。
- 仓库不含真实模型配置，首次运行后需在工作台中自行填写。
- 当前为 MVP 原型，尚未部署到正式服务器；正式男版数字人素材已接入，浏览器播报默认优先选择普通话男声，跨设备一致的生产级 TTS 仍需后续接入。

## 快速开始

需要 Node.js 20.16—20.x，或 Node.js 22.3 及更高版本。

```bash
cd answer-mvp
npm ci
npm start
```

服务默认只监听本机：

- `http://127.0.0.1:8080/`：内容与模型配置工作台。
- `http://127.0.0.1:8080/avatar`：访客数字人问答前台。
- `http://127.0.0.1:8080/health`：服务诊断与依赖状态。
- `http://127.0.0.1:8080/ready`：问答就绪检查。

完整运行、接口、Docker 和安全说明见 [`answer-mvp/README.md`](answer-mvp/README.md)。

## 核心能力

- 使用 `content.json` 维护问法、关键词和已确认的业务知识。
- 通过 Web 导入 TXT、Markdown、CSV、JSON、DOCX 和 PDF，持久化原文件与分片索引。
- 在 Web 工作台中配置 OpenAI 兼容 API 地址、API Key、模型名、提示词和回答范围。
- 通过 `POST /answer` 将用户问题与后台内容交给模型生成答案。
- 以 `idle`、`thinking`、`speaking`、`presenting` 四种视频状态呈现数字人交互。
- 后台使用服务端密码登录、HttpOnly 会话和同源检查，同时保留可选 Bearer 密钥供自动化调用。
- 候选模型连接验证成功后才切换配置，访客快捷问题随内容工作台版本统一更新。
- 对模型上游错误进行脱敏，不向前端泄露 API Key 或上游详情。

## 仓库结构

```text
answer-mvp/                       可运行的 Node.js/Fastify 原型
assets/                           方案文档所用架构图
build_content_platform_proposal.py  技术方案 DOCX 生成脚本
大未来数字人问答_MVP最简方案_V1.2.md  当前最简 MVP 方案
大未来数字人内容中台技术方案_V1.0.md  内容中台技术方案
TIMESTAMP_LOG.md                  项目变更与验证记录
```

## 文档

- [运行与部署说明（中文）](answer-mvp/README.md) / [English](answer-mvp/README.en.md)
- [数字人视频素材说明（中文）](answer-mvp/public/avatar-media/README.md) / [English](answer-mvp/public/avatar-media/README.en.md)
- [项目时间戳日志（中文）](TIMESTAMP_LOG.md) / [English](TIMESTAMP_LOG.en.md)
- [问答 MVP 最简方案 V1.2](大未来数字人问答_MVP最简方案_V1.2.md)
- [内容问答 MVP 极简方案 V1.1](大未来数字人内容问答_MVP极简方案_V1.1.md)
- [内容中台 MVP 实施方案 V1.0](大未来数字人内容中台_MVP实施方案_V1.0.md)
- [内容中台技术方案 V1.0](大未来数字人内容中台技术方案_V1.0.md)

## 验证

```bash
cd answer-mvp
npm test
npm audit --omit=dev
```

当前自动测试共 32 项，覆盖管理密码与会话、知识文件导入与重启恢复、DOCX/PDF 提取、候选配置回滚、回答契约、模型配置安全、内容热加载、错误脱敏、数字人状态机和视频 Range 请求。

## 公开仓库安全边界

- 请勿提交 `answer-mvp/model-config.json`、`admin-auth.json`、`knowledge.json`、`knowledge-files/`、`.env`、私钥或真实 API Key。
- 远程开放后台前必须设置强 `ADMIN_PASSWORD`，并由反向代理提供 HTTPS、限流和适当的日志策略。
- 仓库中的数字人视频是技术联调用演示素材，不代表最终真人形象。
- Public 仅表示仓库内容公开可见；当前未附开源许可证，不自动授予复制、修改或分发许可。
