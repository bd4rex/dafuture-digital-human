[中文](README.md)

# Background-Embedded Digital-Human Video Assets

Idle, thinking, and speaking retain the September 8, 2026 videos; presenting uses a separate asset supplied on September 13. All backgrounds are baked into the frame, removing the alpha-decoder requirement. All four states use H.264 MP4: Constrained Baseline / Level 3.1, 720×960, 30 fps, yuv420p, no audio, and Fast Start.

| State | Delivery file | Duration | Bytes |
| --- | --- | --- | --- |
| Idle | `idle.mp4` | 5.07 s | 566,438 |
| Thinking | `thinking.mp4` | 4.93 s | 525,964 |
| Speaking | `speaking.mp4` | 3.50 s | 394,032 |
| Presenting | `presenting.mp4` | 5.00 s | 547,928 |

The videos total **2,034,362 bytes (about 2.03 MB)**. Each state also has a 540×720 `{state}-poster.jpg` of about 35–42 KB. Initial phone avatar media remains approximately 0.61 MB for idle plus its poster, excluding application code and API traffic. Only the presenting video and poster changed; the other three states retain their original bytes.

## Motion Mapping

Choose by observed movement, not filenames. The September 8 Default Pose master has visible speaking mouth motion, so it is used for speaking. The September 13 presenting asset mainly holds a steady pose, smiles, and blinks; it is used for hosting as requested. Original masters remain unchanged.

| Frontend state | Relative master path | Processing |
| --- | --- | --- |
| Idle | `对话版（最新）.mp4` | Entire clip |
| Thinking | `思考姿态（全新）.mp4` | Entire clip |
| Speaking | `默认姿势（最新版/默认姿势（最新版.mp4` | Extract 1.5–5.0 seconds |
| Presenting | `960b3cd689d8730df1235a050746c334.mp4` (September 13) | Entire five-second clip, original audio removed |

Presenting no longer reuses the speaking clip. The new master is 960×1280 at 30 fps, with SHA-256 `eba793515d82dabba2eae610be024fe509d207839fd91c98d504845685b48946`. These are not word-level lip-sync clips. Existing TTS remains separate; the corresponding broadcast pose begins on the actual audio-start event.

## Loading and Compatibility

Framing calibration uses `scale=792:1056,crop=720:960:32:46` for idle, `scale=786:1048,crop=720:960:48:38` for thinking, and `scale=738:984,crop=720:960:2:4` for speaking. The new September 13 presenting clip uses `scale=792:1056,crop=720:960:34:48`. Scaling preserves aspect ratio and is baked into the video; the frontend never changes container size or CSS scale by pose. Samples at 0, 0.5, 1, 2, and 3 seconds give median eye centers of approximately `(361.5,199.7)`, `(360.6,196.7)`, `(360.1,196.1)`, and `(359.1,197.4)`, with median eye spacing of 81.5, 81.9, 82.3, and 82.2 pixels on a 720×960 canvas: roughly 1% scale spread. Natural head movements remain; this is not per-frame pose locking. Speaking uses a 0.7-second poster; presenting uses its first frame, both avoiding a blink.

On portrait phones, the hero occupies approximately 55% of the visible height (49% in preview, or 43% in short preview windows to leave room for the controls and transcript). The heading is a compact 14px prompt, and a single-line composer is about 50px high. Mobile hosting mode hides the unavailable composer to reserve space for the script. Short windows / an open keyboard still prioritize visible input and dialogue. Landscape keeps the side-by-side layout.

- Phones initially load only idle. Other poses load during interaction; on normal networks, thinking prepares speaking while the model / TTS is working. Normal desktop connections may preload thinking after idle.
- Data saver and 2G / 3G connections load only the active pose. Four persistent video buffers avoid deliberately discarding successfully loaded media; browsers may still fetch additional byte ranges.
- Muted inline playback uses `playsinline`, `webkit-playsinline`, and `x5-playsinline="true"`, following the attribute combination in the [official XGPlayer configuration documentation](https://h5player.bytedance.com/config/#playsinline). Fullscreen and orientation are not forced. Native `play()` is invoked immediately, without requiring a preceding `loadeddata` event that mobile browsers may delay.
- Autoplay rejection retains a poster of the same male character and offers a play button. Network / decoding failures offer reload. Retry calls native playback within the click, retaining user activation; the old cartoon fallback is removed.
- The first-frame timeout is 12 seconds. Stale playback completions cannot override newer states. Hidden pages pause the avatar and retry the current pose on return. Reduced motion shows the corresponding real-person poster only.
- Presenting video and poster URLs use `v=hosting-v3-aligned-20260913`; the other states retain `v=background-v2-aligned-20260908` to avoid unnecessary downloads. The server allowlists these files and provides correct MIME, HEAD, Range / 206 / 416 responses. The player module uses `no-cache`.
- Mobile layout provides a separately scrolling transcript, bottom composer, 16px input text, 44px controls, safe-area padding, Visual Viewport keyboard-height adaptation, and a side-by-side landscape layout.
- `/avatar?preview=1` retains all four pose buttons and adds media status / failure diagnostics. Normal visitors do not see the debug panel.

MP4 removes these assets' alpha-codec dependency; it does not guarantee autoplay, microphone, or TTS availability in every WeChat version. Deployment still needs Xiaomi 15 WeChat checks for first load, tap-to-play, all poses, keyboard changes, and background / foreground recovery. Desktop Chromium phone-sized viewport tests are not physical WeChat acceptance.

## Rebuild

To update only this presenting asset, run from `answer-mvp` with `ffmpeg` and `ffprobe` installed:

```bash
PRESENTING_FRAME_FILTER='scale=792:1056:flags=lanczos,crop=720:960:34:48' \
PRESENTING_POSTER_TIME=0 PRESENTING_START=0 PRESENTING_DURATION=5 \
bash scripts/build-background-avatar.sh --state presenting \
  /path/to/960b3cd689d8730df1235a050746c334.mp4
```

To rebuild all four states, use this exact master mapping:

```bash
AVATAR_BACKGROUND_DIR=/path/to/更新版视频
AVATAR_HOSTING_SOURCE=/path/to/960b3cd689d8730df1235a050746c334.mp4
IDLE_FRAME_FILTER='scale=792:1056:flags=lanczos,crop=720:960:32:46' \
THINKING_FRAME_FILTER='scale=786:1048:flags=lanczos,crop=720:960:48:38' \
SPEAKING_FRAME_FILTER='scale=738:984:flags=lanczos,crop=720:960:2:4' \
PRESENTING_FRAME_FILTER='scale=792:1056:flags=lanczos,crop=720:960:34:48' \
SPEAKING_POSTER_TIME=0.7 PRESENTING_POSTER_TIME=0 \
SPEAKING_START=1.5 SPEAKING_DURATION=3.5 \
PRESENTING_START=0 PRESENTING_DURATION=5 \
bash scripts/build-background-avatar.sh \
  "$AVATAR_BACKGROUND_DIR/对话版（最新）.mp4" \
  "$AVATAR_BACKGROUND_DIR/思考姿态（全新）.mp4" \
  "$AVATAR_BACKGROUND_DIR/默认姿势（最新版/默认姿势（最新版.mp4" \
  "$AVATAR_HOSTING_SOURCE"
```

The script encodes and checks for audio-free H.264 in a temporary directory before replacing only the selected MP4s and posters. Without `--state`, it still processes all four states. It expects a 3:4 composition; inspect other aspect ratios before conversion to avoid distortion. Update the affected state cache version; change the initial HTML poster version only when replacing idle. Restart the service / rebuild the deployment because HTML and configuration templates are read at startup.

## Legacy Alpha Assets

Previous `.webm` / `.mov` files, `source/`, and legacy builders remain for cached historical pages or an explicit rollback. Current configuration does not request them. Do not run an alpha builder as the MP4 build step or remove files that older cached pages may still request.
