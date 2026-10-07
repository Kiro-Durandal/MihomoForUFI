#!/system/bin/sh

set -u

D=$(dirname "$0")
. "$D/env.sh"

case "${1:-}" in
  '') CONFIG_VALIDATED=0 ;;
  --validated-config) CONFIG_VALIDATED=1 ;;
  *) echo "Unknown start option: $1" >&2; exit 1 ;;
esac

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

listeners_ready() {
  SOCKETS=$(ss -lntu 2>/dev/null || true)
  printf '%s\n' "$SOCKETS" | grep '^tcp' | grep -q ":$TPROXY_PORT[[:space:]]" || return 1
  printf '%s\n' "$SOCKETS" | grep '^udp' | grep -q ":$TPROXY_PORT[[:space:]]" || return 1
  printf '%s\n' "$SOCKETS" | grep '^tcp' | grep -q ":$DNS_PORT[[:space:]]" || return 1
  printf '%s\n' "$SOCKETS" | grep '^udp' | grep -q ":$DNS_PORT[[:space:]]" || return 1
}

trim_log_before_start() {
  [ -f "$LOG" ] || return 0
  SIZE=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  [ "$SIZE" -gt "$LOG_MAX_BYTES" ] 2>/dev/null || return 0

  TEMP_LOG=$BASE/logs/.mihomo.previous.$$.tmp
  if tail -c "$LOG_KEEP_BYTES" "$LOG" > "$TEMP_LOG" 2>/dev/null; then
    chmod 600 "$TEMP_LOG" 2>/dev/null || true
    mv "$TEMP_LOG" "$LOG.previous" || return 1
    : > "$LOG" || return 1
    chmod 600 "$LOG" 2>/dev/null || true
    printf 'Trimmed Mihomo log from %s bytes; preserved the last %s bytes in %s.previous\n' \
      "$SIZE" "$LOG_KEEP_BYTES" "$LOG"
  else
    rm -f "$TEMP_LOG"
    return 1
  fi
}

mkdir -p "$BASE/bin" "$BASE/config" "$BASE/providers" "$BASE/logs" "$BASE/run" || exit 1
[ -x "$BIN" ] || { echo "Missing executable: $BIN"; exit 1; }
[ -f "$CFG" ] || { echo "Missing config: $CFG"; exit 1; }

if [ -f "$PIDFILE" ]; then
  P=$(head -n 1 "$PIDFILE" 2>/dev/null || true)
  if is_our_mihomo "$P"; then
    "$D/firewall-start.sh" || exit $?
    echo "Already running; TProxy rules refreshed: $P"
    exit 0
  fi
  echo "Removing stale or foreign PID file: ${P:-empty}" >&2
  rm -f "$PIDFILE"
fi

P=$(find_existing_mihomo 2>/dev/null || true)
if [ -n "$P" ]; then
  printf '%s\n' "$P" > "$PIDFILE"
  "$D/firewall-start.sh" || exit $?
  echo "Recovered running Mihomo and refreshed TProxy rules, PID=$P"
  exit 0
fi

if [ "$CONFIG_VALIDATED" -eq 0 ]; then
  "$BIN" -t -d "$BASE" -f "$CFG" || exit 1
fi
trim_log_before_start || { echo "Failed to trim oversized Mihomo log" >&2; exit 1; }

nohup "$BIN" -d "$BASE" -f "$CFG" </dev/null >>"$LOG" 2>&1 &
P=$!
printf '%s\n' "$P" > "$PIDFILE"
READY=0
WAIT_TRY=0
while [ "$WAIT_TRY" -lt 30 ]; do
  sleep 1
  if ! is_our_mihomo "$P"; then break; fi
  if listeners_ready; then READY=1; break; fi
  WAIT_TRY=$((WAIT_TRY + 1))
done

if [ "$READY" -ne 1 ]; then
  tail -n 80 "$LOG" 2>/dev/null || true
  if is_our_mihomo "$P"; then
    kill "$P" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  echo 'Mihomo did not expose the TProxy and DNS listeners within 30 seconds.' >&2
  exit 1
fi

"$D/firewall-start.sh"
RESULT=$?
if [ "$RESULT" -ne 0 ]; then
  "$D/firewall-stop.sh" >/dev/null 2>&1 || true
  kill "$P" 2>/dev/null || true
  sleep 1
  kill -9 "$P" 2>/dev/null || true
  rm -f "$PIDFILE"
  exit "$RESULT"
fi

echo "Mihomo started, PID=$P"
