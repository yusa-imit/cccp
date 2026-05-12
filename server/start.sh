#!/usr/bin/env bash
# ccp-inbox launcher.
#
# Resolution order:
#   1. ${CCP_BIN}                              (env override)
#   2. dist/ccp-inbox-<os>-<arch>              (platform-tagged prebuilt)
#   3. dist/ccp-inbox                          (generic local build)
#   4. bun → build dist/ccp-inbox on the fly, then exec it
#   5. error with a copy-pasteable download command
#
# The MCP stdio channel must stay clean, so all chatter from this wrapper goes
# to stderr.

set -e

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_SLUG="yusa-imit/ccp"

# --- detect platform --------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "[ccp] ERROR: unsupported OS '$(uname -s)'. Only macOS and Linux are released." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "[ccp] ERROR: unsupported arch '$(uname -m)'." >&2; exit 1 ;;
esac
PLATFORM="${OS}-${ARCH}"
PLATFORM_BIN="$DIR/dist/ccp-inbox-${PLATFORM}"
GENERIC_BIN="$DIR/dist/ccp-inbox"

# --- 1. explicit override ---------------------------------------------------
if [ -n "${CCP_BIN:-}" ] && [ -x "$CCP_BIN" ]; then
  exec "$CCP_BIN"
fi

# --- 2/3. prebuilt binary ---------------------------------------------------
if [ -x "$PLATFORM_BIN" ]; then
  exec "$PLATFORM_BIN"
fi
if [ -x "$GENERIC_BIN" ]; then
  exec "$GENERIC_BIN"
fi

# --- 4. compile-on-first-run with bun ---------------------------------------
if command -v bun >/dev/null 2>&1; then
  echo "[ccp] no prebuilt binary found; compiling with bun (one-time, ~5s)…" >&2
  if [ ! -d "$DIR/node_modules" ]; then
    (cd "$DIR" && bun install --silent >&2) || {
      echo "[ccp] ERROR: 'bun install' failed in $DIR" >&2; exit 1
    }
  fi
  mkdir -p "$DIR/dist"
  (cd "$DIR" && bun build --compile --minify --sourcemap inbox.ts --outfile dist/ccp-inbox >&2) || {
    echo "[ccp] ERROR: 'bun build --compile' failed" >&2; exit 1
  }
  exec "$GENERIC_BIN"
fi

# --- 5. no runtime, no binary -----------------------------------------------
DOWNLOAD_URL="https://github.com/${REPO_SLUG}/releases/latest/download/ccp-inbox-${PLATFORM}"
cat >&2 <<EOF
[ccp] ERROR: no runtime available.

ccp-inbox needs either:
  (a) a prebuilt binary at:
        $PLATFORM_BIN
      Download it with:
        mkdir -p "$DIR/dist"
        curl -L -o "$PLATFORM_BIN" "$DOWNLOAD_URL"
        chmod +x "$PLATFORM_BIN"

  (b) Bun installed (https://bun.sh) so the wrapper can compile on first run.
EOF
exit 127
