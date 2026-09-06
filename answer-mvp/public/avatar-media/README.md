[English](README.en.md)

# 数字人透明视频素材

前台按以下固定文件名读取四种姿态：

| 状态 | Chromium / Edge | Safari |
| --- | --- | --- |
| 默认待机 | `idle.webm` | `idle.mov` |
| 思考 | `thinking.webm` | `thinking.mov` |
| 说话 | `speaking.webm` | `speaking.mov` |
| 主持 | `presenting.webm` | `presenting.mov` |

当前四组文件使用 2026-09-06 提供的“抠图版 6.0”数字人素材。输入为 1080×1440、30fps 的 QTRLE Alpha MOV 母版；网页交付版统一转为 720×960、30fps，原始母版保留在项目目录之外。

- Chromium / Edge 使用 VP9 Alpha WebM，四段合计约 2.3 MB，比上一版减少约 64%。
- Safari 使用 HEVC Alpha MOV，四段合计约 5.9 MB，比上一版减少约 43%。以上 MB 按十进制计量，浏览器只加载适用格式。
- 保留新母版的透明边缘，WebM 使用 CRF 30，HEVC Alpha 质量为 0.8；所有交付视频都移除了母版音轨。
- 四种状态各保留一个 `<video>` 缓冲层。首页先加载待机；在非节省流量网络上接着预装思考，进入思考后再预装说话，主持按需加载。已加载素材保留在各自层中，反复切换不重新下载。
- 思考母版首尾姿势不一致，交付版使用前 3.9 秒往返处理，避免循环时手势突然跳变。
- 素材名称与动作不完全对应，因此按实拍动作分配状态。新“对话模式”和“主持姿态”母版主要为微笑、眨眼；新“默认姿势”母版有明显说话口型。对话与主持共用后者的 1.5–5.0 秒片段，但保留独立状态和视频文件，不改变已有的 TTS 音频驱动切换逻辑。循环视频不是逐字口型同步。
- `avatar-config.json` 中的八个素材地址统一使用 `v=cutout-v6-20260906`，避免沿用旧视频缓存。

当前母版映射（不要仅凭文件名重建）：

| 页面状态 | 抠图版 6.0 母版 | 处理 | 交付时长 |
| --- | --- | --- | --- |
| 默认待机 | `对话模式6.0/对话模式6.0.mov` | 全片 | 约 4.07 秒 |
| 思考 | `思考模式6.0/思考模式6.0.mov` | 前 3.9 秒正放后倒放 | 7.8 秒 |
| 对话 | `默认姿势6.0/默认姿势6.0.mov` | 截取 1.5–5.0 秒 | 3.5 秒 |
| 主持 | `默认姿势6.0/默认姿势6.0.mov` | 截取 1.5–5.0 秒 | 3.5 秒 |

`主持姿态6.0/主持姿态6.0.mov` 已检查，但本轮未选用；母版原文件未改动。

素材建议：

- 时长 3–8 秒，无音轨，首尾姿态必须能无缝衔接。
- 四段视频的画布大小、人物站位、脚底基线和色彩管理保持一致。
- WebM 使用 VP9 Alpha；Safari 版本使用 HEVC with Alpha。
- 不要在视频中混入语音。问答音频由前端单独播放，并以音频结束事件退回待机状态。

如需从四段透明 MOV 母版重新生成正式素材，在 `answer-mvp` 目录执行：

```bash
bash scripts/build-production-avatar.sh \
  /path/to/idle.mov \
  /path/to/thinking.mov \
  /path/to/speaking.mov \
  /path/to/presenting.mov
```

重建本轮“抠图版 6.0”时，使用以下映射与截取参数：

```bash
AVATAR_V6_DIR=/path/to/抠图版
SPEAKING_START=1.5 SPEAKING_DURATION=3.5 \
PRESENTING_START=1.5 PRESENTING_DURATION=3.5 \
bash scripts/build-production-avatar.sh \
  "$AVATAR_V6_DIR/对话模式6.0/对话模式6.0.mov" \
  "$AVATAR_V6_DIR/思考模式6.0/思考模式6.0.mov" \
  "$AVATAR_V6_DIR/默认姿势6.0/默认姿势6.0.mov" \
  "$AVATAR_V6_DIR/默认姿势6.0/默认姿势6.0.mov"
```

构建 HEVC Alpha 版本需要 macOS 的 `hevc_videotoolbox` 编码器。脚本先在临时目录完成转码并检查 WebM Alpha 标记，再替换交付文件。

如需恢复内置矢量演示素材，执行：

```bash
bash scripts/build-avatar-demo.sh
```

SVG 源文件位于 `source/`，仅用于恢复演示视频；运行演示素材脚本会覆盖当前正式素材。
