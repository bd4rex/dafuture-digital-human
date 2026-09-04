[中文](README.md)

# Transparent Digital-Human Video Assets

The frontend loads the four poses using these fixed filenames:

| State | Chromium / Edge | Safari |
| --- | --- | --- |
| Default idle | `idle.webm` | `idle.mov` |
| Thinking | `thinking.webm` | `thinking.mov` |
| Speaking | `speaking.webm` | `speaking.mov` |
| Presenting | `presenting.webm` | `presenting.mov` |

The four current media sets contain the production digital-human identity. Their masters were 1080×1440, 30 fps QTRLE Alpha MOV files. Web delivery copies are 720×960 at 30 fps, while the lossless masters remain outside this project directory.

- Chromium and Edge use VP9 Alpha WebM; all four clips total about 5.4 MB.
- Safari uses HEVC Alpha MOV; all four clips total about 9.8 MB.
- Each state keeps its own `<video>` buffer. The page loads idle first; on networks without data saving enabled it then preloads thinking, and entering thinking preloads speaking. Presenting remains on demand. Loaded clips stay in their own layers, so repeated state switches do not download them again.
- The thinking master ended in a different pose from its first frame. Its delivery copy plays the first 3.9 seconds forward and backward to avoid a visible hand-position jump at the loop boundary.

Media recommendations:

- Use 3–8 second clips without audio, with poses that loop seamlessly from end to start.
- Keep the canvas size, character position, foot baseline, and color management consistent across all four clips.
- Use VP9 Alpha for WebM and HEVC with Alpha for Safari.
- Do not embed speech in the video. The frontend plays Q&A audio separately and returns to idle when the audio ends.

To rebuild the production media from four transparent MOV masters, run this command from `answer-mvp`:

```bash
bash scripts/build-production-avatar.sh \
  /path/to/idle.mov \
  /path/to/thinking.mov \
  /path/to/speaking.mov \
  /path/to/presenting.mov
```

To restore the built-in vector demo media, run:

```bash
bash scripts/build-avatar-demo.sh
```

The SVG files in `source/` are used only to restore the demo videos. Running the demo build script overwrites the current production media.
