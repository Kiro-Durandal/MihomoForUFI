#!/system/bin/sh

set -u

D=$(dirname "$0")
. "$D/env.sh"

valid_pid() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 1 ] 2>/dev/null
}

is_our_mihomo() {
  CHECK_PID=${1:-}
  valid_pid "$CHECK_PID" || return 1
  kill -0 "$CHECK_PID" 2>/dev/null || return 1
  EXE=$(readlink "/proc/$CHECK_PID/exe" 2>/dev/null || true)
  [ "$EXE" = "$BIN" ] && return 0
  CMDLINE=$(tr '\000' ' ' < "/proc/$CHECK_PID/cmdline" 2>/dev/null || true)
  case "$CMDLINE" in
    "$BIN"|"$BIN "*) return 0 ;;
  esac
  return 1
}

find_existing_mihomo() {
  for PROC_DIR in /proc/[0-9]*; do
    FOUND_PID=${PROC_DIR##*/}
    if is_our_mihomo "$FOUND_PID"; then
      printf '%s\n' "$FOUND_PID"
      return 0
    fi
  done
  return 1
}

stop_one() {
  STOP_PID=${1:-}
  is_our_mihomo "$STOP_PID" || return 0
  kill "$STOP_PID" 2>/dev/null || true
  COUNT=0
  while is_our_mihomo "$STOP_PID" && [ "$COUNT" -lt 5 ]; do
    sleep 1
    COUNT=$((COUNT + 1))
  done
  if is_our_mihomo "$STOP_PID"; then kill -9 "$STOP_PID" 2>/dev/null || true; fi
}

# Firewall cleanup must remain available even if the binary, configuration or
# PID file is missing.
"$D/firewall-stop.sh" || true

P=''
if [ -f "$PIDFILE" ]; then
  CANDIDATE=$(head -n 1 "$PIDFILE" 2>/dev/null || true)
  if is_our_mihomo "$CANDIDATE"; then P=$CANDIDATE; fi
fi

if [ -z "$P" ]; then P=$(find_existing_mihomo 2>/dev/null || true); fi

if [ -n "$P" ]; then stop_one "$P"; fi

# Clean up any additional exact-path Mihomo processes left by an interrupted
# legacy start. Never match or kill unrelated processes by name alone.
for PROC_DIR in /proc/[0-9]*; do
  EXTRA_PID=${PROC_DIR##*/}
  if is_our_mihomo "$EXTRA_PID"; then stop_one "$EXTRA_PID"; fi
done

rm -f "$PIDFILE"
echo "Mihomo stopped."
