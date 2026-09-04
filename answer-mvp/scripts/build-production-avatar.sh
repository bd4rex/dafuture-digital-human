#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "用法: $0 idle.mov thinking.mov speaking.mov presenting.mov" >&2
  exit 2
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "需要先安装 ffmpeg。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${PROJECT_DIR}/public/avatar-media"
STAGING_DIR="$(mktemp -d -t dafuture-avatar-production)"
trap 'rm -rf "${STAGING_DIR}"' EXIT

IDLE_INPUT="$1"
THINKING_INPUT="$2"
SPEAKING_INPUT="$3"
PRESENTING_INPUT="$4"

for input in \
  "${IDLE_INPUT}" \
  "${THINKING_INPUT}" \
  "${SPEAKING_INPUT}" \
  "${PRESENTING_INPUT}"; do
  if [[ ! -f "${input}" ]]; then
    echo "找不到母版文件: ${input}" >&2
    exit 1
  fi
done

encode_standard() {
  local state="$1"
  local input="$2"

  ffmpeg -hide_banner -loglevel error -y \
    -i "${input}" -an \
    -vf "scale=720:960:flags=lanczos,format=yuva420p" \
    -c:v libvpx-vp9 -b:v 0 -crf 32 -deadline good -cpu-used 2 \
    -row-mt 1 -tile-columns 2 -auto-alt-ref 0 -g 60 -pix_fmt yuva420p \
    "${STAGING_DIR}/${state}.webm"

  ffmpeg -hide_banner -loglevel error -y \
    -i "${input}" -an \
    -vf "scale=720:960:flags=lanczos,format=bgra" \
    -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.65 \
    -tag:v hvc1 -pix_fmt bgra -movflags +faststart \
    "${STAGING_DIR}/${state}.mov"
}

encode_thinking() {
  local input="$1"
  local forward_filter
  forward_filter="[0:v]trim=start=0:end=3.9,setpts=PTS-STARTPTS,split=2[forward][reversebase];[reversebase]reverse,setpts=PTS-STARTPTS[reverse];[forward][reverse]concat=n=2:v=1:a=0"

  ffmpeg -hide_banner -loglevel error -y \
    -i "${input}" -an \
    -filter_complex "${forward_filter},scale=720:960:flags=lanczos,format=yuva420p[out]" \
    -map "[out]" \
    -c:v libvpx-vp9 -b:v 0 -crf 32 -deadline good -cpu-used 2 \
    -row-mt 1 -tile-columns 2 -auto-alt-ref 0 -g 60 -pix_fmt yuva420p \
    "${STAGING_DIR}/thinking.webm"

  ffmpeg -hide_banner -loglevel error -y \
    -i "${input}" -an \
    -filter_complex "${forward_filter},scale=720:960:flags=lanczos,format=bgra[out]" \
    -map "[out]" \
    -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.65 \
    -tag:v hvc1 -pix_fmt bgra -movflags +faststart \
    "${STAGING_DIR}/thinking.mov"
}

encode_standard idle "${IDLE_INPUT}"
encode_thinking "${THINKING_INPUT}"
encode_standard speaking "${SPEAKING_INPUT}"
encode_standard presenting "${PRESENTING_INPUT}"

for state in idle thinking speaking presenting; do
  alpha_mode="$(
    ffprobe -v error -select_streams v:0 \
      -show_entries stream_tags=alpha_mode \
      -of default=noprint_wrappers=1:nokey=1 \
      "${STAGING_DIR}/${state}.webm"
  )"
  if [[ "${alpha_mode}" != "1" ]]; then
    echo "${state}.webm 没有有效 Alpha 标记。" >&2
    exit 1
  fi
done

for state in idle thinking speaking presenting; do
  install -m 0644 "${STAGING_DIR}/${state}.webm" "${OUTPUT_DIR}/${state}.webm"
  install -m 0644 "${STAGING_DIR}/${state}.mov" "${OUTPUT_DIR}/${state}.mov"
done

du -h "${OUTPUT_DIR}"/{idle,thinking,speaking,presenting}.{webm,mov}
