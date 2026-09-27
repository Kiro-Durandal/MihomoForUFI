#!/system/bin/sh

set -u

D=$(dirname "$0")
. "$D/env.sh"

BOOT_LOG=/data/local/tmp/f50_mihomo_boot.log
mkdir -p "$BASE/run" "$BASE/logs"

# The boot log used to grow forever. Trim it before opening the append
# redirection so the operation is safe and deterministic.
if [ -f "$BOOT_LOG" ]; then
  BOOT_SIZE=$(wc -c < "$BOOT_LOG" 2>/dev/null || echo 0)
  if [ "$BOOT_SIZE" -gt "$BOOT_LOG_MAX_BYTES" ] 2>/dev/null; then
    BOOT_TEMP=/data/local/tmp/.f50_mihomo_boot.$$.tmp
    if tail -c "$BOOT_LOG_KEEP_BYTES" "$BOOT_LOG" > "$BOOT_TEMP" 2>/dev/null; then
      cat "$BOOT_TEMP" > "$BOOT_LOG"
      rm -f "$BOOT_TEMP"
      chmod 600 "$BOOT_LOG" 2>/dev/null || true
    else
      rm -f "$BOOT_TEMP"
    fi
  fi
fi

{
  echo ""
  echo "===== F50 Mihomo dual-stack boot start ====="
  echo "Start time: $(date)"

  # Wait for Android boot completion, at most about three minutes.
  COUNT=0
  while [ "$(getprop sys.boot_completed)" != "1" ]; do
    sleep 2
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -ge 90 ]; then
      echo "Warning: Android boot completion timeout"
      break
    fi
  done

  echo "Android boot state: $(getprop sys.boot_completed)"
  echo "Time: $(date)"

  # Wait for the hotspot bridge, then for its stable IPv4 and global IPv6
  # prefixes. IPv6 timeout is non-fatal so IPv4 still starts when the carrier
  # temporarily provides no IPv6 service.
  COUNT=0
  until ip link show "$LAN_IF" >/dev/null 2>&1; do
    sleep 2
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -ge 60 ]; then
      echo "Error: $LAN_IF not found"
      exit 1
    fi
  done

  COUNT=0
  until ip -4 addr show dev "$LAN_IF" 2>/dev/null | grep -q 'inet '; do
    sleep 2
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -ge 60 ]; then
      echo "Warning: $LAN_IF IPv4 address timeout"
      break
    fi
  done

  COUNT=0
  until ip -6 addr show dev "$LAN_IF" scope global 2>/dev/null | grep -q 'inet6 '; do
    sleep 2
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -ge 60 ]; then
      echo "Warning: $LAN_IF global IPv6 prefix timeout; continuing with IPv4 available"
      break
    fi
  done

  echo "$LAN_IF IPv4 state:"
  ip -4 addr show dev "$LAN_IF" 2>/dev/null || true
  echo "$LAN_IF IPv6 state:"
  ip -6 addr show dev "$LAN_IF" 2>/dev/null || true

  # Give the mobile network and Android networking services time to settle.
  sleep 20

  if [ -f "$PIDFILE" ]; then
    PID=$(head -n 1 "$PIDFILE" 2>/dev/null || true)
    case "$PID" in
      ''|*[!0-9]*) ;;
      *)
        if kill -0 "$PID" 2>/dev/null; then
          EXE=$(readlink "/proc/$PID/exe" 2>/dev/null || true)
          if [ "$EXE" = "$BIN" ]; then
            echo "Mihomo already running, PID=$PID"
            exit 0
          fi
        fi
        ;;
    esac
  fi

  [ -x "$BIN" ] || { echo "Error: Mihomo binary not executable"; exit 1; }
  [ -f "$CFG" ] || { echo "Error: config.yaml not found"; exit 1; }

  echo "Starting Mihomo..."
  "$D/start.sh"
  RESULT=$?
  echo "start.sh result: $RESULT"

  sleep 3
  echo "Status after start:"
  "$D/status.sh"
  echo "Finish time: $(date)"
  exit "$RESULT"
} >> "$BOOT_LOG" 2>&1
