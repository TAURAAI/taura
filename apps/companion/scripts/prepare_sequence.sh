#!/usr/bin/env bash
# Robustness flags (guard for minimal shells that lack 'pipefail' or 'u')
set -e
# Some stripped / older bash builds on Windows Git environments may not support -o pipefail or -u
{ set -o pipefail 2>/dev/null; } || true
{ set -u 2>/dev/null; } || true

# Usage: scripts/prepare_sequence.sh [input_video] [output_dir] [target_width] [format] [upscale_video_width] [quality] [lossless]
#   format: jpg|png|webp (default: jpg)
#   upscale_video_width: if provided, first create an upscaled MP4 used for extraction
#   quality: encoder dependent (webp: 0-100; jpg: 1(best)-31). Optional.
#   lossless: for webp set to 1 to force lossless. Optional.
# Defaults: input=../../runpod-generatied-video.mp4, output=../public/sequence, width=2880, format=jpg, no video upscale
# Windows PowerShell invocation examples (note: don't use backticks as line continuations when embedding inside bash call):
#   bash apps/companion/scripts/prepare_sequence.sh ./Runpod-generated-video.mp4 apps/companion/public/sequence 2880 webp "" 82
# Or simply (uses defaults if video present at repo root):
#   bash apps/companion/scripts/prepare_sequence.sh

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
ROOT_DIR=$(cd "$APP_DIR/../.." && pwd)

INPUT_VIDEO=${1:-"$ROOT_DIR/runpod-generatied-video.mp4"}
OUT_DIR=${2:-"$APP_DIR/public/sequence"}
TARGET_WIDTH=${3:-2880}
FORMAT=${4:-jpg}
UPSCALE_W=${5:-}
QUALITY=${6:-}
LOSSLESS=${7:-}

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Please install ffmpeg." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Optional: upscale source video first for better intermediate quality
if [ -n "$UPSCALE_W" ]; then
  UPSCALED_MP4="${INPUT_VIDEO%.*}_upscaled_${UPSCALE_W}.mp4"
  echo "Upscaling source video to width=$UPSCALE_W → $UPSCALED_MP4" >&2
  ffmpeg -y -hide_banner -loglevel error \
    -i "$INPUT_VIDEO" \
    -vf "scale=${UPSCALE_W}:-1:flags=lanczos,unsharp=5:5:0.8:5:5:0.0" \
    -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p -tune film \
    -c:a copy \
    "$UPSCALED_MP4"
  INPUT_VIDEO="$UPSCALED_MP4"
fi

echo "Cleaning existing frames in $OUT_DIR" >&2
rm -f "$OUT_DIR"/aurora-*.* || true

EXT="$FORMAT"
FF_OPTS=""
case "$FORMAT" in
  jpg|jpeg)
    EXT="jpg"
    Q=${QUALITY:-1}
    FF_OPTS="-c:v mjpeg -pix_fmt yuvj444p -q:v ${Q}"
    ;;
  png)
    EXT="png"
    FF_OPTS="-c:v png -compression_level 100"
    ;;
  webp)
    EXT="webp"
    # WebP (requires libwebp). Lossless if LOSSLESS=1 else lossy with quality (default 82)
    if [ "${LOSSLESS}" = "1" ]; then
      FF_OPTS="-c:v libwebp -lossless 1 -qscale 0"
    else
      Q=${QUALITY:-82}
      FF_OPTS="-c:v libwebp -q:v ${Q} -compression_level 6"
    fi
    ;;
  *)
    echo "Unknown format '$FORMAT'. Use jpg|png|webp." >&2
    exit 1
    ;;
esac

echo "Extracting + upscaling frames from $INPUT_VIDEO to width=$TARGET_WIDTH using lanczos... (format=$FORMAT)" >&2

# Suggested quality-size tradeoffs:
#   jpg: QUALITY=2-4 (1 is largest/best). Use 4 for ~visually lossless with smaller size.
#   webp lossy: QUALITY=78-85 for high quality (default 82). 82 is a sweet spot.
#   webp lossless: set LOSSLESS=1 (larger). Only use for artifacts-sensitive UI sequences.
# Example (best quality moderate size WebP):
#   ./scripts/prepare_sequence.sh "$ROOT_DIR/runpod-generatied-video.mp4" "$APP_DIR/public/sequence" 2880 webp "" 82
# Example (fast JPEG, a bit smaller):
#   ./scripts/prepare_sequence.sh "$ROOT_DIR/runpod-generatied-video.mp4" "$APP_DIR/public/sequence" 2560 jpg "" 4
ffmpeg -y -hide_banner -loglevel error \
  -i "$INPUT_VIDEO" \
  -vf "scale=${TARGET_WIDTH}:-1:flags=lanczos,unsharp=5:5:0.8:5:5:0.0" \
  $FF_OPTS \
  "$OUT_DIR"/aurora-%03d.$EXT

COUNT=$(ls "$OUT_DIR"/aurora-*.${EXT} 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" = "0" ]; then
  echo "No frames extracted" >&2
  exit 1
fi

cat > "$OUT_DIR"/manifest.json <<JSON
{
  "dir": "/sequence",
  "base": "aurora-",
  "ext": ".${EXT}",
  "frameCount": $COUNT,
  "pad": 3
}
JSON

echo "Prepared $COUNT frames at width=$TARGET_WIDTH in $OUT_DIR (format=$FORMAT)" >&2
