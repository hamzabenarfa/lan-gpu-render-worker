#!/usr/bin/env bash
# remote-render.sh — Send a films/<id>/ project from Linux to the Windows GPU worker and download the rendered MP4.
#
# Usage (from your project repo root):
#   ./remote-render.sh specs/<id>.json [workers]
#   ./remote-render.sh --film-dir films/<id> --id <id> --dur <sec> [--wk 4]
#
# Requires RENDER_HOST and RENDER_TOKEN in env (or in ./.env).
set -euo pipefail

# Load .env from current directory if RENDER_HOST or RENDER_TOKEN is unset
if [ -z "${RENDER_HOST:-}" ] || [ -z "${RENDER_TOKEN:-}" ]; then
  if [ -f ".env" ]; then
    while IFS='=' read -r k v; do
      case "$k" in
        RENDER_HOST|RENDER_TOKEN)
          v="${v%\"}"
          v="${v#\"}"
          v="${v%\'}"
          v="${v#\'}"
          [ -z "${!k:-}" ] && export "$k=$v"
          ;;
      esac
    done < <(grep -E '^(RENDER_HOST|RENDER_TOKEN)=' .env || true)
  fi
fi

usage() {
  cat >&2 <<EOF
Usage:
  $0 <spec.json> [workers]
  $0 --film-dir <dir> --id <filmId> --dur <seconds> [--wk 4] [--encoder auto|nvenc|x264]

Environment variables (or .env):
  RENDER_HOST   e.g. http://192.168.1.50:8787
  RENDER_TOKEN  shared token from .token on the Windows desktop PC
EOF
  exit 2
}

SPEC=""
FILM_DIR=""
ID=""
DUR=""
WK="${WK:-4}"
ENCODER="${RENDER_ENCODER:-auto}"

while [ $# -gt 0 ]; do
  case "$1" in
    --film-dir) FILM_DIR="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    --dur) DUR="$2"; shift 2 ;;
    --wk) WK="$2"; shift 2 ;;
    --encoder) ENCODER="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "Unknown flag: $1" >&2; usage ;;
    *)
      if [ -z "$SPEC" ]; then SPEC="$1"
      else WK="$1"
      fi
      shift
      ;;
  esac
done

if [ -n "$SPEC" ]; then
  if [ ! -f "$SPEC" ]; then
    echo "ERROR: spec file not found: $SPEC" >&2
    exit 1
  fi
  read -r ID DUR < <(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(s.id, s.targetDurationSec);
  ' "$SPEC")
  [ -z "$FILM_DIR" ] && FILM_DIR="films/${ID}"
fi

[ -z "$FILM_DIR" ] || [ -z "$ID" ] || [ -z "$DUR" ] && usage
[ -z "${RENDER_HOST:-}" ] && { echo "ERROR: RENDER_HOST is not set" >&2; exit 2; }
[ -z "${RENDER_TOKEN:-}" ] && { echo "ERROR: RENDER_TOKEN is not set" >&2; exit 2; }
[ ! -d "$FILM_DIR" ] && { echo "ERROR: film folder not found: $FILM_DIR (run just export-film first)" >&2; exit 1; }

RENDER_HOST="${RENDER_HOST%/}"

# 1. Quick health check
if ! curl -fsS --connect-timeout 5 "${RENDER_HOST}/health" >/dev/null; then
  echo "ERROR: Cannot reach worker at ${RENDER_HOST}/health" >&2
  echo "Check that start-worker.bat is running on the Windows PC and both machines are on the same LAN." >&2
  exit 1
fi

# 2. Pack films/<id>/ (excluding old render/ outputs)
TMP_TAR="$(mktemp "/tmp/remote-render-${ID}-XXXXXX.tar.gz")"
cleanup() { rm -f "$TMP_TAR"; }
trap cleanup EXIT

echo "[remote-render] Packing ${FILM_DIR}..."
tar -czf "$TMP_TAR" --exclude=./render --exclude=./snaps -C "$FILM_DIR" .
SIZE_MB=$(du -m "$TMP_TAR" | awk '{print $1}')
echo "[remote-render] Uploading ${SIZE_MB} MB to ${RENDER_HOST} (id=${ID}, dur=${DUR}s, wk=${WK})..."

JOB_ID=$(curl -fsS -X POST \
  -H "X-Render-Token: ${RENDER_TOKEN}" \
  --data-binary "@${TMP_TAR}" \
  "${RENDER_HOST}/jobs?id=${ID}&dur=${DUR}&wk=${WK}&encoder=${ENCODER}" \
  | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(j.jobId || "");')

if [ -z "$JOB_ID" ]; then
  echo "ERROR: Worker did not return a jobId" >&2
  exit 1
fi
echo "[remote-render] Job ${JOB_ID} queued"

# 3. Poll status and stream logs
PRINTED=0
while true; do
  JSON=$(curl -fsS -H "X-Render-Token: ${RENDER_TOKEN}" "${RENDER_HOST}/jobs/${JOB_ID}")
  STATUS=$(printf '%s' "$JSON" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).status)')
  NEW_COUNT=$(printf '%s' "$JSON" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    const from = Number(process.argv[1]);
    for (const line of j.logs.slice(from)) console.error("[gpu] " + line);
    console.log(j.logs.length);
  ' "$PRINTED")
  PRINTED="$NEW_COUNT"

  if [ "$STATUS" = "done" ]; then
    break
  elif [ "$STATUS" = "failed" ]; then
    ERR=$(printf '%s' "$JSON" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).error || "unknown")')
    echo "ERROR: Remote render failed: ${ERR}" >&2
    exit 1
  fi
  sleep 2
done

# 4. Download rendered MP4 directly into films/<id>/render/<id>.mp4
OUT_DIR="${FILM_DIR}/render"
OUT_MP4="${OUT_DIR}/${ID}.mp4"
mkdir -p "$OUT_DIR"
TMP_MP4="${OUT_MP4}.tmp"

echo "[remote-render] Downloading rendered video -> ${OUT_MP4}"
curl -fsS -H "X-Render-Token: ${RENDER_TOKEN}" \
  "${RENDER_HOST}/jobs/${JOB_ID}/video.mp4" \
  -o "$TMP_MP4"

if [ ! -s "$TMP_MP4" ]; then
  rm -f "$TMP_MP4"
  echo "ERROR: Downloaded MP4 is empty" >&2
  exit 1
fi
mv "$TMP_MP4" "$OUT_MP4"

# 5. Delete temp files on desktop PC
curl -fsS -X DELETE -H "X-Render-Token: ${RENDER_TOKEN}" "${RENDER_HOST}/jobs/${JOB_ID}" >/dev/null || true
echo "[remote-render] Done: ${OUT_MP4}"
