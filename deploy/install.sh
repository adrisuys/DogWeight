#!/bin/bash
# Install the two launchd jobs:
#   * the web server (restarted on crash and on login)
#   * the daily weigh-in reminder check
#
#   ./deploy/install.sh          install / reinstall
#   ./deploy/install.sh remove   uninstall
#   ./deploy/install.sh dry-run  write the plist to ./logs/dry-run and stop,
#                                without touching launchd — use this to check
#                                what would be installed
#
# The reminder job runs every morning and decides for itself: it asks how long
# it has been since the last weighing rather than counting down from when it
# was installed, so weighing early moves the next reminder out on its own.
# `cli remind` is a no-op on the days it isn't due.
#
# launchd agents run as you, on login. The Mac must therefore be logged in —
# which it is, if it just sits at home plugged into the wall.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PYTHON="$APP_DIR/venv/bin/python"
WEB_LABEL="com.dogmanagement.web"
REMIND_LABEL="com.dogmanagement.remind"
REMIND_HOUR="${DOG_REMIND_HOUR:-9}"
PORT="${DOG_PORT:-8760}"
UID_NUM="$(id -u)"
MODE="${1:-install}"

if [ "$MODE" = "dry-run" ]; then
  AGENTS_DIR="$APP_DIR/logs/dry-run"
fi

unload() {
  launchctl bootout "gui/$UID_NUM/$1" 2>/dev/null || true
}

if [ "$MODE" = "remove" ]; then
  unload "$WEB_LABEL"
  unload "$REMIND_LABEL"
  rm -f "$AGENTS_DIR/$WEB_LABEL.plist" "$AGENTS_DIR/$REMIND_LABEL.plist"
  echo "Removed both launchd jobs."
  exit 0
fi

if [ ! -x "$PYTHON" ]; then
  echo "No virtualenv at $PYTHON — create it first (see README)." >&2
  exit 1
fi

# The advice shells out to `claude`, and launchd gives a job a minimal PATH
# that does not include Homebrew. Resolve it now and pass the absolute path,
# so the first weighing after a reboot doesn't fail with "introuvable".
CLAUDE_BIN="${DOG_CLAUDE_BIN:-$(command -v claude || true)}"
if [ -z "$CLAUDE_BIN" ]; then
  echo "Warning: \`claude\` not found on PATH — the app will run, but the" >&2
  echo "advice will fail until DOG_CLAUDE_BIN points at the binary." >&2
fi

mkdir -p "$AGENTS_DIR" "$APP_DIR/logs"

write_plist() {
  local label="$1" plist="$AGENTS_DIR/$1.plist"
  shift
  local schedule="$1"
  shift

  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo '  <key>ProgramArguments</key>'
    echo '  <array>'
    for arg in "$@"; do
      echo "    <string>$arg</string>"
    done
    echo '  </array>'
    echo "  <key>WorkingDirectory</key><string>$APP_DIR</string>"
    echo "  <key>StandardOutPath</key><string>$APP_DIR/logs/$label.log</string>"
    echo "  <key>StandardErrorPath</key><string>$APP_DIR/logs/$label.log</string>"
    echo '  <key>EnvironmentVariables</key>'
    echo '  <dict>'
    echo "    <key>DOG_PORT</key><string>$PORT</string>"
    [ -n "$CLAUDE_BIN" ] && echo "    <key>DOG_CLAUDE_BIN</key><string>$CLAUDE_BIN</string>"
    echo '  </dict>'
    echo '  <key>RunAtLoad</key><true/>'
    echo "$schedule"
    echo '</dict>'
    echo '</plist>'
  } > "$plist"

  plutil -lint "$plist" > /dev/null || { echo "generated a malformed plist: $plist" >&2; exit 1; }

  if [ "$MODE" = "dry-run" ]; then
    echo "  wrote $plist (not loaded)"
    return
  fi

  unload "$label"
  launchctl bootstrap "gui/$UID_NUM" "$plist"
  echo "  loaded $label"
}

# KeepAlive: bring the server back if it exits for any reason.
write_plist "$WEB_LABEL" '  <key>KeepAlive</key><true/>' \
  "$PYTHON" -m app.cli serve --host 127.0.0.1 --port "$PORT"

# StartCalendarInterval: once each morning. The job itself decides whether
# anything is due, so running it daily costs nothing on the other 20 days.
write_plist "$REMIND_LABEL" \
  "  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$REMIND_HOUR</integer><key>Minute</key><integer>0</integer></dict>" \
  "$PYTHON" -m app.cli remind

if [ "$MODE" = "dry-run" ]; then
  echo
  echo "Dry run complete. Nothing was installed."
  exit 0
fi

cat <<EOF

Done. The app is on http://127.0.0.1:$PORT, and the reminder runs at
${REMIND_HOUR}:00 each morning.
Logs: $APP_DIR/logs/

Stop the Mac from sleeping while on mains power:
  sudo pmset -c sleep 0 disablesleep 0

Publish it to your own devices over HTTPS:
  tailscale serve --bg $PORT
  tailscale serve status
EOF
