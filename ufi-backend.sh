#!/system/bin/sh
# F50 Mihomo UFI-Tools backend 2.6-rc2.2
# Fixed-action backend: no eval, no arbitrary shell execution.

set -u

BASE=/data/f50-mihomo
SCRIPTS=$BASE/scripts
BIN=$BASE/bin/mihomo
CFG=$BASE/config/config.yaml
BACKUP_DIR=$BASE/backups
RUN_DIR=$BASE/run
PIDFILE=$RUN_DIR/mihomo.pid
BOOT_LOG=/data/local/tmp/f50_mihomo_boot.log
BOOT_FILE=/sdcard/ufi_tools_boot.sh
BOOT_MATCH=/data/f50-mihomo/scripts/boot-start.sh
BOOT_COMMAND='sh /data/f50-mihomo/scripts/boot-start.sh >/dev/null 2>&1 &'
LOCK_DIR=$RUN_DIR/ufi-backend.lock
CURL=/data/data/com.minikano.f50_sms/files/curl
UPLOAD_ROOT=/data/data/com.minikano.f50_sms/files/uploads
MIHOMO_LOG=$BASE/logs/mihomo.log
MIHOMO_PREVIOUS_LOG=$BASE/logs/mihomo.log.previous
PENDING_MARKER=$RUN_DIR/setup-pending
MANGLE_CHAIN4=F50_MIHOMO
DNS_CHAIN4=F50_MIHOMO_DNS
MANGLE_CHAIN6=F50_MIHOMO6
ROUTE_TABLE=2022
RULE_PREF=9000
MARK=0x40000000
MARK_MASK=0x40000000

mkdir -p "$RUN_DIR" "$BACKUP_DIR"

say() { printf '%s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

read_first_line() {
  [ -f "$1" ] || return 1
  sed -n '1p' "$1" 2>/dev/null
}

pid_value() {
  read_first_line "$PIDFILE" 2>/dev/null || true
}

valid_pid() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 1 ] 2>/dev/null
}

is_mihomo_pid() {
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

is_running() {
  P=$(pid_value)
  is_mihomo_pid "$P"
}

release_lock() {
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    trap release_lock EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    return 0
  fi

  OLD_PID="$(read_first_line "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    die "另一个 UFI 后端操作正在运行（PID $OLD_PID）"
  fi

  rm -rf "$LOCK_DIR" 2>/dev/null || true
  mkdir "$LOCK_DIR" 2>/dev/null || die "无法取得后端操作锁"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  trap release_lock EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

require_base() {
  [ -x "$BIN" ] || die "未找到可执行 Mihomo：$BIN"
  [ -f "$CFG" ] || die "未找到配置：$CFG"
  [ -x "$SCRIPTS/start.sh" ] || die "未找到 start.sh"
  [ -x "$SCRIPTS/stop.sh" ] || die "未找到 stop.sh"
}

require_configured() {
  [ ! -f "$PENDING_MARKER" ] || die '请先在设备管理窗口填写并应用订阅链接'
}

require_stop() {
  [ -x "$SCRIPTS/stop.sh" ] || die "未找到 stop.sh，无法安全清理代理规则"
}

file_size() {
  [ -f "$1" ] || { printf '0\n'; return 0; }
  wc -c < "$1" 2>/dev/null || printf '0\n'
}

check_backup_name() {
  NAME="${1:-}"
  printf '%s' "$NAME" | grep -Eq '^config-[0-9]+\.yaml$' || die "回滚点名称无效"
  [ -f "$BACKUP_DIR/$NAME" ] || die "回滚点不存在：$NAME"
}

check_upload_path() {
  PATH_IN="${1:-}"
  case "$PATH_IN" in
    "$UPLOAD_ROOT"/*) ;;
    *) die "上传文件路径不在 UFI-Tools 上传目录" ;;
  esac

  BASE_NAME="${PATH_IN##*/}"
  [ "$PATH_IN" = "$UPLOAD_ROOT/$BASE_NAME" ] || die "上传路径无效"
  printf '%s' "$BASE_NAME" | grep -Eq '^[A-Za-z0-9._-]+$' || die "上传文件名无效"
  [ -f "$PATH_IN" ] || die "上传文件不存在"
  [ ! -L "$PATH_IN" ] || die "拒绝符号链接上传文件"

  SIZE="$(wc -c < "$PATH_IN" 2>/dev/null || echo 0)"
  [ "$SIZE" -gt 0 ] || die "上传文件为空"
  [ "$SIZE" -le 3145728 ] || die "配置文件超过 3 MB"
}

new_backup_path() {
  STAMP="$(date +%s 2>/dev/null || echo 0)$$"
  printf '%s/config-%s.yaml\n' "$BACKUP_DIR" "$STAMP"
}

create_backup() {
  [ -f "$CFG" ] || die "当前配置不存在"
  DEST="$(new_backup_path)"
  cp "$CFG" "$DEST" || die "创建回滚点失败"
  chmod 600 "$DEST" 2>/dev/null || true
  printf '%s\n' "$DEST"
}

controller_port() {
  VALUE=$(awk '
    /^external-controller[[:space:]]*:/ {
      value=$0
      sub(/^[^:]*:[[:space:]]*/, "", value)
      sub(/[[:space:]]+#.*/, "", value)
      gsub(/^[[:space:]]+/, "", value)
      gsub(/[[:space:]]+$/, "", value)
      if ((substr(value,1,1) == "\"" && substr(value,length(value),1) == "\"") ||
          (substr(value,1,1) == "\047" && substr(value,length(value),1) == "\047")) {
        value=substr(value,2,length(value)-2)
      }
      print value
      exit
    }
  ' "$CFG" 2>/dev/null)
  case "$VALUE" in
    *:*) PORT=${VALUE##*:} ;;
    *) return 1 ;;
  esac
  case "$PORT" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$PORT" -ge 1 ] 2>/dev/null || return 1
  [ "$PORT" -le 65535 ] 2>/dev/null || return 1
  printf '%s\n' "$PORT"
}

ports_ready() {
  SOCKETS=$(ss -lntu 2>/dev/null || true)
  CONTROLLER_PORT=$(controller_port) || return 1
  printf '%s\n' "$SOCKETS" | grep '^tcp' | grep -q ':7894[[:space:]]' || return 1
  printf '%s\n' "$SOCKETS" | grep '^udp' | grep -q ':7894[[:space:]]' || return 1
  printf '%s\n' "$SOCKETS" | grep '^tcp' | grep -q ':1053[[:space:]]' || return 1
  printf '%s\n' "$SOCKETS" | grep '^udp' | grep -q ':1053[[:space:]]' || return 1
  printf '%s\n' "$SOCKETS" | grep '^tcp' | grep -q ":$CONTROLLER_PORT[[:space:]]" || return 1
}

rules4_ready() {
  ip rule show 2>/dev/null | grep "^$RULE_PREF:" | grep -q "fwmark $MARK/$MARK_MASK.*lookup $ROUTE_TABLE" || return 1
  ip route show table "$ROUTE_TABLE" 2>/dev/null | grep -Eq 'local (default|0\.0\.0\.0/0) dev lo' || return 1
  iptables -t mangle -S "$MANGLE_CHAIN4" 2>/dev/null | grep -q -- '-p tcp -j TPROXY' || return 1
  iptables -t mangle -S "$MANGLE_CHAIN4" 2>/dev/null | grep -q -- '-p udp -j TPROXY' || return 1
  iptables -t nat -S "$DNS_CHAIN4" 2>/dev/null | grep -q -- '-p udp -j REDIRECT' || return 1
  iptables -t nat -S "$DNS_CHAIN4" 2>/dev/null | grep -q -- '-p tcp -j REDIRECT' || return 1
}

rules6_ready() {
  ip -6 rule show 2>/dev/null | grep "^$RULE_PREF:" | grep -q "fwmark $MARK/$MARK_MASK.*lookup $ROUTE_TABLE" || return 1
  ip -6 route show table "$ROUTE_TABLE" 2>/dev/null | grep -Eq 'local (default|::/0) dev lo' || return 1
  ip6tables -t mangle -S "$MANGLE_CHAIN6" 2>/dev/null | grep -q -- '-p tcp -j TPROXY' || return 1
  ip6tables -t mangle -S "$MANGLE_CHAIN6" 2>/dev/null | grep -q -- '-p udp -j TPROXY' || return 1
}

health_quiet() {
  is_running && ports_ready && rules4_ready && rules6_ready
}

controller_reachable() {
  [ -x "$CURL" ] || return 1
  API_PORT=$(controller_port) || return 1
  API_SECRET=$(awk '/^secret:/ {sub(/^secret:[[:space:]]*/, ""); print; exit}' "$CFG" 2>/dev/null | sed "s/^[ '\"]*//;s/[ '\"]*$//")
  [ -n "$API_SECRET" ] || return 1
  API_REPLY=$("$CURL" -fsS --connect-timeout 2 --max-time 5 \
    -H "Authorization: Bearer $API_SECRET" \
    "http://127.0.0.1:$API_PORT/version" 2>/dev/null) || return 1
  printf '%s' "$API_REPLY" | grep -q '"version"'
}

status_action() {
  INSTALLED=0
  [ -x "$BIN" ] && [ -f "$CFG" ] && INSTALLED=1

  CONFIGURED=0
  [ "$INSTALLED" -eq 1 ] && [ ! -f "$PENDING_MARKER" ] && CONFIGURED=1

  RUNNING=0
  PID="$(pid_value)"
  if is_mihomo_pid "$PID"; then RUNNING=1; fi

  BOOT=0
  grep -Fq "$BOOT_MATCH" "$BOOT_FILE" 2>/dev/null && BOOT=1

  UI=0
  [ -f "$BASE/ui/index.html" ] && UI=1

  BACKEND_VERSION=2.6-rc2.2
  VERSION=''
  if [ -x "$BIN" ]; then
    VERSION="$($BIN -v 2>/dev/null | head -n 1 || true)"
  fi

  IPV4=0
  rules4_ready && IPV4=1
  IPV6=0
  rules6_ready && IPV6=1
  LOG_BYTES=$(file_size "$MIHOMO_LOG")
  BOOT_LOG_BYTES=$(file_size "$BOOT_LOG")
  CONTROLLER_PORT=$(controller_port 2>/dev/null || true)

  printf 'installed=%s\nconfigured=%s\nrunning=%s\npid=%s\nboot=%s\nui=%s\nipv4=%s\nipv6=%s\ncontroller_port=%s\nlog_bytes=%s\nboot_log_bytes=%s\nbackend=%s\nversion=%s\n' \
    "$INSTALLED" "$CONFIGURED" "$RUNNING" "$PID" "$BOOT" "$UI" "$IPV4" "$IPV6" \
    "$CONTROLLER_PORT" "$LOG_BYTES" "$BOOT_LOG_BYTES" "$BACKEND_VERSION" "$VERSION"
}

health_action() {
  say '== process =='
  if is_running; then say "running PID=$(pid_value)"; else say 'stopped'; fi
  say '== ports =='
  CONTROLLER_PORT=$(controller_port 2>/dev/null || true)
  case "$CONTROLLER_PORT" in
    ''|*[!0-9]*) ss -lntu 2>/dev/null | grep -E ':(7894|1053)[[:space:]]' || true ;;
    *) ss -lntu 2>/dev/null | grep -E ":(7894|1053|$CONTROLLER_PORT)[[:space:]]" || true ;;
  esac
  say '== ip rule =='
  ip rule show 2>/dev/null | grep "^$RULE_PREF:" || true
  ip -6 rule show 2>/dev/null | grep "^$RULE_PREF:" || true
  say '== IPv4 route table =='
  ip route show table "$ROUTE_TABLE" 2>/dev/null || true
  say '== IPv6 route table =='
  ip -6 route show table "$ROUTE_TABLE" 2>/dev/null || true
  say '== IPv4 PREROUTING =='
  iptables -t mangle -S PREROUTING 2>/dev/null | grep "$MANGLE_CHAIN4" || true
  iptables -t nat -S PREROUTING 2>/dev/null | grep "$DNS_CHAIN4" || true
  say '== IPv6 PREROUTING =='
  ip6tables -t mangle -S PREROUTING 2>/dev/null | grep "$MANGLE_CHAIN6" || true
  say '== IPv4 chains =='
  iptables -t mangle -S "$MANGLE_CHAIN4" 2>/dev/null || true
  iptables -t nat -S "$DNS_CHAIN4" 2>/dev/null || true
  say '== IPv6 chain =='
  ip6tables -t mangle -S "$MANGLE_CHAIN6" 2>/dev/null || true
  say '== health =='
  if health_quiet; then say 'OK'; else say 'INCOMPLETE'; fi
}

start_action() {
  acquire_lock
  require_base
  require_configured
  "$SCRIPTS/start.sh"
  sleep 2
  health_quiet || die "启动后健康检查未通过"
  say 'OK: Mihomo 已启动且健康检查通过'
}

stop_action() {
  acquire_lock
  require_stop
  "$SCRIPTS/stop.sh"
  say 'OK: Mihomo 已停止'
}

restart_action() {
  acquire_lock
  require_base
  require_configured
  "$SCRIPTS/stop.sh"
  sleep 1
  "$SCRIPTS/start.sh"
  sleep 2
  health_quiet || die "重启后健康检查未通过"
  say 'OK: Mihomo 已重启且健康检查通过'
}

boot_enable_action() {
  acquire_lock
  require_configured
  touch "$BOOT_FILE" || die "无法访问开机脚本"
  if ! grep -Fq "$BOOT_MATCH" "$BOOT_FILE" 2>/dev/null; then
    printf '%s\n' "$BOOT_COMMAND" >> "$BOOT_FILE" || die "写入开机自启失败"
  fi
  say 'OK: 已开启开机自启'
}

boot_disable_action() {
  acquire_lock
  [ -f "$BOOT_FILE" ] || { say 'OK: 开机自启本来就是关闭状态'; return 0; }
  sed -i "\#$BOOT_MATCH#d" "$BOOT_FILE" || die "更新开机脚本失败"
  say 'OK: 已关闭开机自启'
}

config_test_action() {
  require_base
  TARGET="${1:-$CFG}"
  if [ "$TARGET" != "$CFG" ]; then check_upload_path "$TARGET"; fi
  "$BIN" -t -d "$BASE" -f "$TARGET"
}

config_read_action() {
  [ -f "$CFG" ] || die "当前配置不存在"
  [ "$(file_size "$CFG")" -le 3145728 ] 2>/dev/null || die "当前配置超过 3 MB，拒绝发送到浏览器"
  cat "$CFG" || die "读取配置失败"
}

config_apply_action() {
  acquire_lock
  require_base
  WAS_PENDING=0
  [ -f "$PENDING_MARKER" ] && WAS_PENDING=1
  SOURCE="${1:-}"
  check_upload_path "$SOURCE"

  TEMP="$BASE/config/config.upload.$$"
  NEWCFG="$BASE/config/config.new.$$"
  SAFETY=''
  CLEAN_SOURCE="$SOURCE"

  cleanup_apply() {
    rm -f "$TEMP" "$NEWCFG" "$CLEAN_SOURCE" 2>/dev/null || true
  }
  trap 'cleanup_apply; release_lock' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  cp "$SOURCE" "$TEMP" || die "复制上传配置失败"
  chmod 600 "$TEMP" 2>/dev/null || true
  "$BIN" -t -d "$BASE" -f "$TEMP" || die "上传配置校验失败"

  SAFETY="$(create_backup)"
  "$SCRIPTS/stop.sh" || true

  cp "$TEMP" "$NEWCFG" || die "准备新配置失败"
  chmod 600 "$NEWCFG" 2>/dev/null || true
  mv "$NEWCFG" "$CFG" || die "替换正式配置失败"

  START_OK=0
  if "$SCRIPTS/start.sh"; then
    sleep 2
    if health_quiet; then
      API_TRY=0
      while [ "$API_TRY" -lt 3 ]; do
        if controller_reachable; then START_OK=1; break; fi
        API_TRY=$((API_TRY + 1))
        sleep 1
      done
    fi
  fi

  if [ "$START_OK" -eq 1 ]; then
    if [ "$WAS_PENDING" -eq 1 ]; then
      rm -f "$PENDING_MARKER" || die '配置已生效，但无法清除待配置标记'
      if touch "$BOOT_FILE" && { grep -Fq "$BOOT_MATCH" "$BOOT_FILE" 2>/dev/null || printf '%s\n' "$BOOT_COMMAND" >> "$BOOT_FILE"; }; then
        say 'OK: 首次配置完成，已开启开机自启'
      else
        say 'WARN: 配置已生效，但开机自启设置失败；请稍后手动开启'
      fi
    fi
    say "OK: 配置已应用"
    say "backup=${SAFETY##*/}"
    exit 0
  fi

  "$SCRIPTS/stop.sh" >/dev/null 2>&1 || true
  cp "$SAFETY" "$CFG" || die "新配置失败，且无法恢复安全备份"
  chmod 600 "$CFG" 2>/dev/null || true
  [ "$WAS_PENDING" -eq 1 ] || "$SCRIPTS/start.sh" >/dev/null 2>&1 || true
  die "新配置应用后双栈或控制器健康检查失败，已尝试恢复操作前配置"
}

backup_create_action() {
  acquire_lock
  PATH_OUT="$(create_backup)"
  say "OK: 已创建回滚点"
  say "name=${PATH_OUT##*/}"
}

backup_list_action() {
  mkdir -p "$BACKUP_DIR"
  ls -1t "$BACKUP_DIR"/config-*.yaml 2>/dev/null | sed 's#.*/##' || true
}

backup_read_action() {
  check_backup_name "${1:-}"
  [ "$(file_size "$BACKUP_DIR/$NAME")" -le 3145728 ] 2>/dev/null || die "回滚点超过 3 MB，拒绝发送到浏览器"
  cat "$BACKUP_DIR/$NAME" || die "读取回滚点失败"
}

backup_delete_action() {
  acquire_lock
  check_backup_name "${1:-}"
  rm -f "$BACKUP_DIR/$NAME" || die "删除回滚点失败"
  say 'OK: 回滚点已删除'
}

backup_restore_action() {
  acquire_lock
  require_base
  check_backup_name "${1:-}"
  SELECTED="$BACKUP_DIR/$NAME"

  "$BIN" -t -d "$BASE" -f "$SELECTED" || die "所选回滚点配置校验失败"
  SAFETY="$(create_backup)"
  "$SCRIPTS/stop.sh" || true
  cp "$SELECTED" "$CFG" || die "恢复配置失败"
  chmod 600 "$CFG" 2>/dev/null || true

  RESTORE_OK=0
  if "$SCRIPTS/start.sh"; then
    sleep 2
    health_quiet && RESTORE_OK=1
  fi

  if [ "$RESTORE_OK" -eq 1 ]; then
    say 'OK: 回滚点已恢复'
    say "safety=${SAFETY##*/}"
    exit 0
  fi

  "$SCRIPTS/stop.sh" >/dev/null 2>&1 || true
  cp "$SAFETY" "$CFG" || die "回滚失败，且无法恢复操作前配置"
  chmod 600 "$CFG" 2>/dev/null || true
  "$SCRIPTS/start.sh" >/dev/null 2>&1 || true
  die "回滚后健康检查失败，已尝试返回操作前配置"
}

boot_log_action() {
  [ -f "$BOOT_LOG" ] || { say '（暂无开机日志）'; return 0; }
  tail -n 240 "$BOOT_LOG" 2>/dev/null || die "读取开机日志失败"
}

mihomo_log_action() {
  [ -f "$MIHOMO_LOG" ] || { say '（暂无 Mihomo 日志）'; return 0; }
  say "current_bytes=$(file_size "$MIHOMO_LOG")"
  [ -f "$MIHOMO_PREVIOUS_LOG" ] && say "previous_bytes=$(file_size "$MIHOMO_PREVIOUS_LOG")"
  say '== recent =='
  tail -n 240 "$MIHOMO_LOG" 2>/dev/null || die "读取 Mihomo 日志失败"
}

diagnostic_action() {
  say '== generated =='
  date
  say '== device =='
  printf 'model=%s\nandroid=%s\nabi=%s\n' \
    "$(getprop ro.product.model)" \
    "$(getprop ro.build.version.release)" \
    "$(getprop ro.product.cpu.abi)"
  uptime 2>/dev/null || true
  say '== mihomo =='
  "$BIN" -v 2>&1 | head -n 3 || true
  ps -A 2>/dev/null | grep '[m]ihomo' || true
  health_action
  say '== storage =='
  df -h "$BASE" 2>/dev/null || true
  du -sh "$BASE/ui" "$BASE/providers" "$BACKUP_DIR" 2>/dev/null || true
  printf 'mihomo_log_bytes=%s\nboot_log_bytes=%s\n' \
    "$(file_size "$MIHOMO_LOG")" "$(file_size "$BOOT_LOG")"
  say '== IPv6 capability =='
  printf 'disable_ipv6='; cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || true
  printf 'forwarding='; cat /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null || true
  if grep -qx 'TPROXY' /proc/net/ip6_tables_targets 2>/dev/null; then
    say 'ip6_tproxy=1'
  else
    say 'ip6_tproxy=0'
  fi
  say '== recent warnings =='
  if [ -f "$MIHOMO_LOG" ]; then
    tail -n 600 "$MIHOMO_LOG" 2>/dev/null | grep -iE 'warning|error|failed|timeout|closed network|canceled' | tail -n 120 || true
  fi
}

api_info() {
  SECRET="$(awk '/^secret:/ {sub(/^secret:[[:space:]]*/, ""); print; exit}' "$CFG" 2>/dev/null | sed "s/^[ '\"]*//;s/[ '\"]*$//")"
  [ -n "$SECRET" ] || die "无法读取 Mihomo API 密码"
  CONTROLLER_PORT=$(controller_port) || die '无法从 external-controller 读取 TCP 端口'
  LAN_IP="$(ip -4 addr show dev br0 2>/dev/null | awk '/inet / {sub(/\/.*/,"",$2); print $2; exit}')"
  [ -n "$LAN_IP" ] || LAN_IP=192.168.0.1
}

api_version_action() {
  require_base
  [ -x "$CURL" ] || die "未找到 UFI-Tools curl"
  api_info
  "$CURL" -fsS --connect-timeout 5 --max-time 12 \
    -H "Authorization: Bearer $SECRET" \
    "http://$LAN_IP:$CONTROLLER_PORT/version"
}

# Return Mihomo's provider JSON to the local front end. The front end only
# displays the node count; it must never render addresses or credentials.
provider_status_action() {
  require_base
  require_configured
  is_running || die 'Mihomo 未运行，无法检查订阅加载状态'
  [ -x "$CURL" ] || die '未找到 UFI-Tools curl'
  api_info
  "$CURL" -fsS --connect-timeout 5 --max-time 20 \
    -H "Authorization: Bearer $SECRET" \
    "http://127.0.0.1:$CONTROLLER_PORT/providers/proxies/main" || \
    die '无法从 Mihomo 控制器读取 main 订阅状态'
}

ui_upgrade_action() {
  acquire_lock
  require_base
  [ -x "$CURL" ] || die "未找到 UFI-Tools curl"
  api_info
  "$CURL" -fsS --connect-timeout 5 --max-time 180 -X POST \
    -H "Authorization: Bearer $SECRET" \
    "http://$LAN_IP:$CONTROLLER_PORT/upgrade/ui"
  say 'OK: MetaCubeXD 更新请求已完成'
}

uninstall_action() {
  [ "${1:-}" = 'PURGE' ] || die '卸载确认参数无效'
  acquire_lock
  [ -f "$SCRIPTS/uninstall.sh" ] || die '未找到 uninstall.sh'
  HELPER=/data/local/tmp/f50-mihomo-uninstall.$$.sh
  case "$HELPER" in
    /data/local/tmp/f50-mihomo-uninstall.[0-9]*.sh) ;;
    *) die '卸载临时路径异常' ;;
  esac
  cp "$SCRIPTS/uninstall.sh" "$HELPER" || die '无法准备卸载脚本'
  chmod 700 "$HELPER" || { rm -f "$HELPER"; die '无法设置卸载脚本权限'; }
  exec sh "$HELPER" --self-delete
}

ACTION="${1:-}"
[ -n "$ACTION" ] || die "缺少动作参数"
shift || true

case "$ACTION" in
  status) status_action ;;
  health) health_action ;;
  start) start_action ;;
  stop) stop_action ;;
  restart) restart_action ;;
  boot-enable) boot_enable_action ;;
  boot-disable) boot_disable_action ;;
  config-test) config_test_action "${1:-}" ;;
  config-read) config_read_action ;;
  config-apply) config_apply_action "${1:-}" ;;
  backup-create) backup_create_action ;;
  backup-list) backup_list_action ;;
  backup-read) backup_read_action "${1:-}" ;;
  backup-delete) backup_delete_action "${1:-}" ;;
  backup-restore) backup_restore_action "${1:-}" ;;
  boot-log) boot_log_action ;;
  mihomo-log) mihomo_log_action ;;
  diagnostic) diagnostic_action ;;
  api-version) api_version_action ;;
  provider-status) provider_status_action ;;
  ui-upgrade) ui_upgrade_action ;;
  uninstall) uninstall_action "${1:-}" ;;
  *) die "不支持的动作：$ACTION" ;;
esac
