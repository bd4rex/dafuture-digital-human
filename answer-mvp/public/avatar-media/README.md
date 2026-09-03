[English](README.en.md)

# 数字人透明视频素材

前台按以下固定文件名读取四种姿态：

| 状态 | Chromium / Edge | Safari |
| --- | --- | --- |
| 默认待机 | `idle.webm` | `idle.mov` |
| 思考 | `thinking.webm` | `thinking.mov` |
| 说话 | `speaking.webm` | `speaking.mov` |
| 主持 | `presenting.webm` | `presenting.mov` |

仓库中自带的文件是技术联调用的透明矢量角色演示版。拿到真人拍摄和抠像素材后，保持文件名不变即可替换，前端代码无需修改。替换后将 `../avatar-config.json` 中的 `mediaMode` 从 `demo` 改为 `production`。

素材建议：

- 时长 3–8 秒，无音轨，首尾姿态必须能无缝衔接。
- 四段视频的画布大小、人物站位、脚底基线和色彩管理保持一致。
- WebM 使用 VP9 Alpha；Safari 版本使用 HEVC with Alpha。
- 不要在视频中混入语音。问答音频由前端单独播放，并以音频结束事件退回待机状态。

如需重新生成内置演示素材，在 `answer-mvp` 目录执行：

```bash
bash scripts/build-avatar-demo.sh
```

SVG 源文件位于 `source/`，仅用于生成演示视频，不是正式数字人形象。
