#!/bin/sh
# Wrapper for install.mjs (POSIX). Forwards every argument.
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "[install] Node.js 22 or newer is required, but \"node\" was not found on PATH." >&2
  echo "[install] Install it from https://nodejs.org/ and run this script again." >&2
  exit 1
fi

exec node "$HERE/install.mjs" "$@"
