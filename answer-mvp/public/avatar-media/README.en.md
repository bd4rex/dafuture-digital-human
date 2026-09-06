[中文](README.md)

# Transparent Digital-Human Video Assets

The frontend loads the four poses using these fixed filenames:

| State | Chromium / Edge | Safari |
| --- | --- | --- |
| Default idle | `idle.webm` | `idle.mov` |
| Thinking | `thinking.webm` | `thinking.mov` |
| Speaking | `speaking.webm` | `speaking.mov` |
| Presenting | `presenting.webm` | `presenting.mov` |

The four current media sets use the “Cutout 6.0” assets supplied on 2026-09-06. Their masters are 1080×1440, 30 fps QTRLE Alpha MOV files. Web delivery copies are 720×960 at 30 fps, while the lossless masters remain outside this project directory.

- Chromium and Edge use VP9 Alpha WebM; all four clips total about 2.3 MB, approximately 64% smaller than the previous set.
- Safari uses HEVC Alpha MOV; all four clips total about 5.9 MB, approximately 43% smaller. MB values are decimal; browsers load only the applicable format.
- The new cutout edges are retained with WebM CRF 30 and HEVC Alpha quality 0.8. All delivery clips have their original audio tracks removed.
- Each state keeps its own `<video>` buffer. The page loads idle first; on networks without data saving enabled it then preloads thinking, and entering thinking preloads speaking. Presenting remains on demand. Loaded clips stay in their own layers, so repeated state switches do not download them again.
- The thinking master ended in a different pose from its first frame. Its delivery copy plays the first 3.9 seconds forward and backward to avoid a visible hand-position jump at the loop boundary.
- Source filenames do not consistently describe the actual motion. The new Dialogue and Presenting masters mostly smile and blink, while the new Default Pose master has clear speaking mouth movements. Speaking and presenting both use its 1.5–5.0 second segment, retaining independent states and files without changing the existing TTS audio-driven transitions. These are looping motion clips, not word-level lip synchronization.
- All eight source URLs in `avatar-config.json` use `v=cutout-v6-20260906` to invalidate the previous media cache.

Current master mapping (do not rebuild from filenames alone):

| Frontend state | Cutout 6.0 master | Processing | Delivery duration |
| --- | --- | --- | --- |
| Idle | `对话模式6.0/对话模式6.0.mov` | Entire clip | About 4.07 seconds |
| Thinking | `思考模式6.0/思考模式6.0.mov` | First 3.9 seconds forward, then reversed | 7.8 seconds |
| Speaking | `默认姿势6.0/默认姿势6.0.mov` | Extract 1.5–5.0 seconds | 3.5 seconds |
| Presenting | `默认姿势6.0/默认姿势6.0.mov` | Extract 1.5–5.0 seconds | 3.5 seconds |

`主持姿态6.0/主持姿态6.0.mov` was inspected but is not used in this revision. Original master files are unchanged.

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

To reproduce this Cutout 6.0 revision, use the following mapping and trim settings:

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

Building HEVC Alpha requires the macOS `hevc_videotoolbox` encoder. The script encodes in a temporary directory and checks WebM Alpha tags before replacing delivery files.

To restore the built-in vector demo media, run:

```bash
bash scripts/build-avatar-demo.sh
```

The SVG files in `source/` are used only to restore the demo videos. Running the demo build script overwrites the current production media.
