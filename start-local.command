#!/bin/zsh
set -euo pipefail

cd "/Users/lauhithnatarajan/Documents/games test"
PORT=4173

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Server already running on port $PORT"
else
  nohup python3 -m http.server $PORT > /tmp/reaction-lab-elite.log 2>&1 &
  sleep 1
fi

open "http://127.0.0.1:$PORT/"
echo "Opened http://127.0.0.1:$PORT/ in Safari"
