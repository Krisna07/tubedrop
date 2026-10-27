#!/bin/bash
# upload.sh <upload_url> <file> [content-type] - send a file to a Google resumable upload session in 64 MiB chunks.
# Prints the final JSON response (for a video, its "id" is the video id). Resumes automatically after a dropped chunk.
set -euo pipefail
URL="$1"; FILE="$2"; TYPE="${3:-application/octet-stream}"
TOTAL=$(stat -c %s "$FILE"); CHUNK=$((64 * 1024 * 1024)); OFF=0; TRIES=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
probe() {  # ask Google how much it has; sets OFF, or prints the result and exits if complete
  code=$(curl -s -o "$TMP/r" -D "$TMP/h" -w '%{http_code}' -X PUT -H "Content-Range: bytes */$TOTAL" -H "Content-Length: 0" "$URL")
  if [[ "$code" == 200 || "$code" == 201 ]]; then cat "$TMP/r"; exit 0; fi
  r=$(grep -i '^range:' "$TMP/h" | tr -d '\r' | sed 's/.*-//' || true); OFF=$(( ${r:--1} + 1 ))
}
while (( OFF < TOTAL )); do
  END=$(( OFF + CHUNK < TOTAL ? OFF + CHUNK : TOTAL )); END=$((END - 1)); LEN=$((END - OFF + 1))
  dd if="$FILE" of="$TMP/part" bs=4M iflag=skip_bytes,count_bytes skip=$OFF count=$LEN status=none
  code=$(curl -s -o "$TMP/r" -D "$TMP/h" -w '%{http_code}' -X PUT -H "Content-Type: $TYPE" \
         -H "Content-Range: bytes $OFF-$END/$TOTAL" --data-binary @"$TMP/part" "$URL" || echo 000)
  case "$code" in
    200|201) cat "$TMP/r"; exit 0 ;;
    308) r=$(grep -i '^range:' "$TMP/h" | tr -d '\r' | sed 's/.*-//' || true); OFF=$(( ${r:-$END} + 1 )); TRIES=0
         echo "  $(( OFF * 100 / TOTAL ))% ($((OFF / 1048576)) / $((TOTAL / 1048576)) MB)" >&2 ;;
    *)   TRIES=$((TRIES + 1)); (( TRIES > 5 )) && { echo "upload failed ($code): $(head -c 400 "$TMP/r")" >&2; exit 1; }
         sleep $((TRIES * 3)); probe ;;
  esac
done
probe; echo "upload ended without a final response" >&2; exit 1
