[中文](README.md)

# Transparent Digital-Human Video Assets

The frontend loads the four poses using these fixed filenames:

| State | Chromium / Edge | Safari |
| --- | --- | --- |
| Default idle | `idle.webm` | `idle.mov` |
| Thinking | `thinking.webm` | `thinking.mov` |
| Speaking | `speaking.webm` | `speaking.mov` |
| Presenting | `presenting.webm` | `presenting.mov` |

The files included in the repository are transparent vector-character demos for technical integration. When filmed and keyed real-person media is ready, replace the files while preserving their names; no frontend code changes are required. Then change `mediaMode` in `../avatar-config.json` from `demo` to `production`.

Media recommendations:

- Use 3–8 second clips without audio, with poses that loop seamlessly from end to start.
- Keep the canvas size, character position, foot baseline, and color management consistent across all four clips.
- Use VP9 Alpha for WebM and HEVC with Alpha for Safari.
- Do not embed speech in the video. The frontend plays Q&A audio separately and returns to idle when the audio ends.

To rebuild the included demo media, run this command from `answer-mvp`:

```bash
bash scripts/build-avatar-demo.sh
```

The SVG files in `source/` are used only to build the demo videos; they are not the final digital-human identity.
