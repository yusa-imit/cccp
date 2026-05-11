#!/usr/bin/env bash
# cccp-inbox launcher.
#
# Resolution order:
#   1. ${CCCP_BIN}                              (env override)
#   2. dist/cccp-inbox-<os>-<arch>              (platform-tagged prebuilt)
#   3. dist/cccp-inbox                          (generic local build)
#   4. bun → build dist/cccp-inbox on the fly, then exec it
#   5. error with a copy-pasteable download command
#
# The MCP stdio channel must stay clean, so all chatter from this wrapper goes
# to stderr.

set -e

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_SLUG="yusa-imit/cccp"

# --- detect platform --------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "[cccp] ERROR: unsupported OS '$(uname -s)'. Only macOS and Linux are released." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "[cccp] ERROR: unsupported arch '$(uname -m)'." >&2; exit 1 ;;
esac
PLATFORM="${OS}-${ARCH}"
PLATFORM_BIN="$DIR/dist/cccp-inbox-${PLATFORM}"
GENERIC_BIN="$DIR/dist/cccp-inbox"

# --- 1. explicit override ---------------------------------------------------
if [ -n "${CCCP_BIN:-}" ] && [ -x "$CCCP_BIN" ]; then
  exec "$CCCP_BIN"
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
  echo "[cccp] no prebuilt binary found; compiling with bun (one-time, ~5s)…" >&2
  if [ ! -d "$DIR/node_modules" ]; then
    (cd "$DIR" && bun install --silent >&2) || {
      echo "[cccp] ERROR: 'bun install' failed in $DIR" >&2; exit 1
    }
  fi
  mkdir -p "$DIR/dist"
  (cd "$DIR" && bun build --compile --minify --sourcemap inbox.ts --outfile dist/cccp-inbox >&2) || {
    echo "[cccp] ERROR: 'bun build --compile' failed" >&2; exit 1
  }
  exec "$GENERIC_BIN"
fi

# --- 5. no runtime, no binary -----------------------------------------------
DOWNLOAD_URL="https://github.com/${REPO_SLUG}/releases/latest/download/cccp-inbox-${PLATFORM}"
cat >&2 <<EOF
[cccp] ERROR: no runtime available.

cccp-inbox needs either:
  (a) a prebuilt binary at:
        $PLATFORM_BIN
      Download it with:
        mkdir -p "$DIR/dist"
        curl -L -o "$PLATFORM_BIN" "$DOWNLOAD_URL"
        chmod +x "$PLATFORM_BIN"

  (b) Bun installed (https://bun.sh) so the wrapper can compile on first run.
EOF
exit 127
