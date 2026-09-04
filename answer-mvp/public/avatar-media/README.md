[English](README.en.md)

# 数字人透明视频素材

前台按以下固定文件名读取四种姿态：

| 状态 | Chromium / Edge | Safari |
| --- | --- | --- |
| 默认待机 | `idle.webm` | `idle.mov` |
| 思考 | `thinking.webm` | `thinking.mov` |
| 说话 | `speaking.webm` | `speaking.mov` |
| 主持 | `presenting.webm` | `presenting.mov` |

当前四组文件已替换为正式数字人形象。输入为 1080×1440、30fps 的 QTRLE Alpha MOV 母版；网页交付版统一转为 720×960、30fps，原始母版保留在项目目录之外。

- Chromium / Edge 使用 VP9 Alpha WebM，四段合计约 5.4 MB。
- Safari 使用 HEVC Alpha MOV，四段合计约 9.8 MB。
- 四种状态各保留一个 `<video>` 缓冲层。首页先加载待机；在非节省流量网络上接着预装思考，进入思考后再预装说话，主持按需加载。已加载素材保留在各自层中，反复切换不重新下载。
- 思考母版首尾姿势不一致，交付版使用前 3.9 秒往返处理，避免循环时手势突然跳变。

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

如需恢复内置矢量演示素材，执行：

```bash
bash scripts/build-avatar-demo.sh
```

SVG 源文件位于 `source/`，仅用于恢复演示视频；运行演示素材脚本会覆盖当前正式素材。
