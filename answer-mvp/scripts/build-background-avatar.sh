#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "用法: $0 idle.mp4 thinking.mp4 speaking.mp4 presenting.mp4" >&2
  exit 2
fi
for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null 2>&1 || { echo "需要先安装 $tool。" >&2; exit 1; }
done
for input in "$@"; do
  [[ -f "$input" ]] || { echo "找不到母版: $input" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/../public/avatar-media"
STAGING_DIR="$(mktemp -d -t dafuture-background-avatar)"
trap 'rm -rf "${STAGING_DIR}"' EXIT

encode() {
  local state="$1" input="$2" start="${3:-0}" duration="${4:-}"
  local frame_filter="scale=720:960:flags=lanczos" poster_time="0"
  # Each master can have a different camera crop. Normalize it in the encoded
  # frame, so native/mobile playback and its poster use the same composition.
  case "$state" in
    idle) frame_filter="${IDLE_FRAME_FILTER:-$frame_filter}" ;;
    thinking) frame_filter="${THINKING_FRAME_FILTER:-$frame_filter}" ;;
    speaking) frame_filter="${SPEAKING_FRAME_FILTER:-$frame_filter}"; poster_time="${SPEAKING_POSTER_TIME:-0}" ;;
    presenting) frame_filter="${PRESENTING_FRAME_FILTER:-$frame_filter}"; poster_time="${PRESENTING_POSTER_TIME:-0}" ;;
  esac
  local clip_options=(-ss "$start")
  if [[ -n "$duration" ]]; then clip_options+=(-t "$duration"); fi
  ffmpeg -hide_banner -loglevel error -y -i "$input" "${clip_options[@]}" \
    -map 0:v:0 -an -map_metadata -1 \
    -vf "${frame_filter},fps=30,setsar=1,format=yuv420p" \
    -c:v libx264 -profile:v baseline -level:v 3.1 -preset slow -crf 23 \
    -maxrate 1800k -bufsize 3600k -g 60 -tag:v avc1 -movflags +faststart \
    "${STAGING_DIR}/${state}.mp4"
  ffmpeg -hide_banner -loglevel error -y -ss "$poster_time" \
    -i "${STAGING_DIR}/${state}.mp4" -frames:v 1 \
    -vf "scale=540:720:flags=lanczos" -q:v 2 -update 1 \
    "${STAGING_DIR}/${state}-poster.jpg"
}

encode idle "$1"
encode thinking "$2"
encode speaking "$3" "${SPEAKING_START:-0}" "${SPEAKING_DURATION:-}"
encode presenting "$4" "${PRESENTING_START:-0}" "${PRESENTING_DURATION:-}"

for state in idle thinking speaking presenting; do
  codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${STAGING_DIR}/${state}.mp4")"
  audio="$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${STAGING_DIR}/${state}.mp4")"
  dimensions="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${STAGING_DIR}/${state}.mp4")"
  [[ "$codec" == h264 && -z "$audio" && "$dimensions" == 720x960 ]] || { echo "$state 编码或画幅验证失败。" >&2; exit 1; }
done
for state in idle thinking speaking presenting; do
  install -m 0644 "${STAGING_DIR}/${state}.mp4" "${OUTPUT_DIR}/${state}.mp4"
  install -m 0644 "${STAGING_DIR}/${state}-poster.jpg" "${OUTPUT_DIR}/${state}-poster.jpg"
done
du -h "${OUTPUT_DIR}"/{idle,thinking,speaking,presenting}.mp4 "${OUTPUT_DIR}"/*-poster.jpg
