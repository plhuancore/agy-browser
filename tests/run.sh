#!/usr/bin/env bash
# Runs tests/e2e.mjs against headless Chrome for Testing (branded Chrome ignores
# --load-extension). Uses its own ports, so it doesn't touch a running agy session.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/tests/.cache"
HUB_PORT="${HUB_PORT:-8797}"
SITE_PORT="${SITE_PORT:-8811}"
CHROME_VERSION="${CHROME_VERSION:-stable}"

for port in "$HUB_PORT" "$SITE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; then
    echo "Port $port is in use; set HUB_PORT / SITE_PORT to free ports." >&2
    exit 1
  fi
done

mkdir -p "$CACHE"
(cd "$ROOT" && cargo build --release --quiet)

CHROME="$(find "$CACHE/chrome" -path '*Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' 2>/dev/null | head -1 || true)"
if [ -z "$CHROME" ]; then
  echo "Downloading Chrome for Testing ($CHROME_VERSION)..."
  (cd "$CACHE" && npx -y @puppeteer/browsers@2.10.5 install "chrome@$CHROME_VERSION" >/dev/null)
  CHROME="$(find "$CACHE/chrome" -path '*Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' | head -1)"
fi

# Copy of the extension pointed at the test hub port.
rm -rf "$CACHE/ext" "$CACHE/profile"
cp -R "$ROOT/extension" "$CACHE/ext"
sed -i '' "s/const PORT = 8765;/const PORT = $HUB_PORT;/" "$CACHE/ext/background.js"

python3 -m http.server "$SITE_PORT" --bind 127.0.0.1 --directory "$ROOT/tests/site" >/dev/null 2>&1 &
SITE_PID=$!
"$CHROME" --headless=new --user-data-dir="$CACHE/profile" --no-first-run \
  --load-extension="$CACHE/ext" --disable-extensions-except="$CACHE/ext" about:blank >"$CACHE/chrome.log" 2>&1 &
CHROME_PID=$!
trap 'kill $SITE_PID $CHROME_PID 2>/dev/null || true' EXIT
sleep 3

AGY_BROWSER_BIN="$ROOT/target/release/agy-browser" AGY_BROWSER_PORT="$HUB_PORT" \
  SITE_URL="http://localhost:$SITE_PORT" node "$ROOT/tests/e2e.mjs"
