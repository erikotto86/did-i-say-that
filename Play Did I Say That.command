#!/bin/bash
# Double-click to play "Did I Say That?" in Safari.
# The microphone needs the page served from localhost, so this starts a tiny
# local web server. Close this Terminal window to stop it.
cd "$(dirname "$0")" || exit 1

PORT=8765
while lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
URL="http://localhost:$PORT/"

if /usr/bin/python3 -c 'pass' >/dev/null 2>&1; then
  echo ""
  echo "  🎤  Did I Say That? is running at $URL"
  echo "      Close this window when you're done playing."
  echo ""
  (sleep 1; open -a Safari "$URL") &
  exec /usr/bin/python3 -m http.server "$PORT" --bind 127.0.0.1 2>/dev/null
else
  echo "Python 3 isn't installed (macOS may offer to install the Command Line Tools — say yes, then run this again)."
  echo "Opening in Google Chrome as a fallback..."
  open -a "Google Chrome" "index.html" 2>/dev/null || open "index.html"
fi
