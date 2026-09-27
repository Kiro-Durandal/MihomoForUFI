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

echo "== process =="
if [ -f "$PIDFILE" ]; then
  P=$(head -n 1 "$PIDFILE" 2>/dev/null || true)
  if is_our_mihomo "$P"; then echo "running PID=$P"; else echo "stale or foreign pid"; fi
else
  echo "stopped"
fi

echo "== ports =="
CONTROLLER_PORT=$(awk '
  /^external-controller[[:space:]]*:/ {
    value=$0
    sub(/^[^:]*:[[:space:]]*/, "", value)
    sub(/[[:space:]]+#.*/, "", value)
    gsub(/^[[:space:]\047\"]+/, "", value)
    gsub(/[[:space:]\047\"]+$/, "", value)
    sub(/^.*:/, "", value)
    print value
    exit
  }
' "$CFG" 2>/dev/null || true)
case "$CONTROLLER_PORT" in
  ''|*[!0-9]*) ss -lntup 2>/dev/null | grep -E ':(7894|1053)[[:space:]]' || true ;;
  *) ss -lntup 2>/dev/null | grep -E ":(7894|1053|$CONTROLLER_PORT)[[:space:]]" || true ;;
esac

echo "== IPv4 policy route =="
ip rule show 2>/dev/null | grep "^$RULE_PREF:" || true
ip route show table "$ROUTE_TABLE" 2>/dev/null || true

echo "== IPv6 policy route =="
ip -6 rule show 2>/dev/null | grep "^$RULE_PREF:" || true
ip -6 route show table "$ROUTE_TABLE" 2>/dev/null || true

echo "== IPv4 chains =="
iptables -t mangle -S "$MANGLE_CHAIN4" 2>/dev/null || true
iptables -t nat -S "$DNS_CHAIN4" 2>/dev/null || true

echo "== IPv6 chain =="
ip6tables -t mangle -S "$MANGLE_CHAIN6" 2>/dev/null || true

echo "== log files =="
wc -lc "$LOG" "$LOG.previous" 2>/dev/null || true

echo "== recent log =="
tail -n 40 "$LOG" 2>/dev/null || true
