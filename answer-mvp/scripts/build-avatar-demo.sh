#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_DIR="${PROJECT_DIR}/public/avatar-media/source"
OUTPUT_DIR="${PROJECT_DIR}/public/avatar-media"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "需要先安装 ffmpeg 才能生成演示视频。" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "需要 macOS sips 才能把演示 SVG 渲染为视频源。" >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
RENDER_DIR="$(mktemp -d -t dafuture-avatar-render)"
trap 'rm -rf "${RENDER_DIR}"' EXIT

build_state() {
  local state="$1"
  local duration="$2"
  local cycles="$3"
  local input="${SOURCE_DIR}/${state}.svg"
  local rendered_input="${RENDER_DIR}/${state}.png"
  local webm_output="${OUTPUT_DIR}/${state}.webm"
  local mov_output="${OUTPUT_DIR}/${state}.mov"
  local y_expression="4+3*sin(2*PI*t*${cycles}/${duration})"
  local filter="format=rgba,pad=480:728:0:4:color=black@0,crop=480:720:0:'${y_expression}'"

  sips -s format png "${input}" --out "${rendered_input}" >/dev/null

  echo "生成 ${state}.webm"
  ffmpeg -hide_banner -loglevel error -y \
    -loop 1 -framerate 24 -i "${rendered_input}" \
    -vf "${filter},format=yuva420p" -t "${duration}" -an \
    -c:v libvpx-vp9 -b:v 0 -crf 30 -deadline good -cpu-used 2 \
    -row-mt 1 -auto-alt-ref 0 -g 48 -pix_fmt yuva420p \
    "${webm_output}"

  echo "生成 ${state}.mov"
  if ! ffmpeg -hide_banner -loglevel error -y \
    -loop 1 -framerate 24 -i "${rendered_input}" \
    -vf "${filter},format=bgra" -t "${duration}" -an \
    -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.75 \
    -tag:v hvc1 -pix_fmt bgra -movflags +faststart \
    "${mov_output}"; then
    rm -f "${mov_output}"
    echo "当前设备无法生成 HEVC Alpha，已保留 WebM 版本。" >&2
  fi
}

build_state idle 6 1
build_state thinking 4 1
build_state speaking 3 2
build_state presenting 5 1

echo "数字人演示视频已生成到 ${OUTPUT_DIR}"
