#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="$ROOT_DIR/native/photobox-camera-agent.c"
OUTPUT_FILE="$ROOT_DIR/native/photobox-camera-agent"

if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists libgphoto2; then
  echo "Dependensi build belum tersedia."
  echo "Jalankan: sudo apt install build-essential pkg-config libgphoto2-dev"
  exit 1
fi

echo "Membangun dengan libgphoto2 $(pkg-config --modversion libgphoto2)..."
cc -O2 -Wall -Wextra \
  $(pkg-config --cflags libgphoto2) \
  "$SOURCE_FILE" \
  -o "$OUTPUT_FILE" \
  $(pkg-config --libs libgphoto2)

chmod +x "$OUTPUT_FILE"
echo "Camera agent siap: $OUTPUT_FILE"
