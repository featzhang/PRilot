#!/bin/bash

# PRilot start script (uses gh CLI for GitHub API access)
# Usage: ./start.sh [--port PORT] [--bg] [stop|status|restart|logs]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-3000}"
LOG_FILE="$SCRIPT_DIR/pr-manager.log"
PID_FILE="$SCRIPT_DIR/.pr-manager.pid"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --port) PORT="$2"; shift 2 ;;
    --bg) BACKGROUND=1; shift ;;
    stop) ACTION="stop"; shift ;;
    status) ACTION="status"; shift ;;
    restart) ACTION="restart"; shift ;;
    log|logs) ACTION="logs"; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

export PORT

# Check if process is running
is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  return 1
}

do_stop() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "Stopping PRilot (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "Stopped"
  else
    echo "PRilot is not running"
  fi
}

do_status() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "PRilot is running (PID: $pid, Port: $PORT)"
    echo "Log file: $LOG_FILE"
    echo "URL: http://localhost:$PORT"
  else
    echo "PRilot is not running"
  fi
}

do_start() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "PRilot is already running (PID: $pid)"
    echo "URL: http://localhost:$PORT"
    echo "To restart, run: $0 restart"
    return 0
  fi

  # Check node
  if ! command -v node &>/dev/null; then
    echo "Error: node not found, please install Node.js first"
    exit 1
  fi

  # Check gh CLI
  if ! command -v gh &>/dev/null; then
    echo "Error: gh CLI not found, please install it first (https://cli.github.com)"
    exit 1
  fi

  # Check gh auth status
  GH_AUTH_STATUS="not authenticated"
  if gh auth status &>/dev/null; then
    GH_AUTH_STATUS="authenticated"
  fi

  # Install dependencies
  if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
  fi

  echo "Starting PRilot..."
  echo "  Port: $PORT"
  echo "  gh CLI: $GH_AUTH_STATUS"
  if [ "$GH_AUTH_STATUS" = "not authenticated" ]; then
    echo "  ⚠ Warning: gh CLI is not authenticated. Run 'gh auth login' for full access."
  fi

  if [ "$BACKGROUND" = "1" ]; then
    nohup node server.js >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    if is_running; then
      echo "Background start successful (PID: $(cat "$PID_FILE"))"
      echo "Logs: tail -f $LOG_FILE"
      echo "URL: http://localhost:$PORT"
    else
      echo "Failed to start, check logs: cat $LOG_FILE"
      exit 1
    fi
  else
    echo "URL: http://localhost:$PORT"
    echo "Press Ctrl+C to stop"
    echo "---"
    node server.js
  fi
}

do_logs() {
  if [ -f "$LOG_FILE" ]; then
    tail -f "$LOG_FILE"
  else
    echo "No log file found"
  fi
}

# Execute action
case "${ACTION:-start}" in
  stop)    do_stop ;;
  status)  do_status ;;
  restart) do_stop; sleep 1; do_start ;;
  logs)    do_logs ;;
  start)   do_start ;;
esac
