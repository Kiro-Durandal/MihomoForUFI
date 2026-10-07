#!/system/bin/sh
# Mihomo UFI-Tools backend 2.6-rc2.3
# Fixed-action backend: no eval, no arbitrary shell execution.

set -u

BASE=/data/f50-mihomo
SCRIPTS=$BASE/scripts
BIN=$BASE/bin/mihomo
CFG=$BASE/config/config.yaml
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
MAIN_REFRESH_PENDING=$RUN_DIR/main-refresh-pending
MANGLE_CHAIN4=F50_MIHOMO
DNS_CHAIN4=F50_MIHOMO_DNS
MANGLE_CHAIN6=F50_MIHOMO6
ROUTE_TABLE=2022
RULE_PREF=9000
MARK=0x40000000
MARK_MASK=0x40000000

mkdir -p "$RUN_DIR"

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
  if [ -L "$CFG" ]; then
    CONFIG_TARGET=$(readlink "$CFG") || die '无法读取配置链接'
    printf '%s' "$CONFIG_TARGET" | grep -Eq '^MiConfig-[0-9]{12}\.yaml$' || die '配置链接目标无效'
    [ ! -L "$BASE/config/$CONFIG_TARGET" ] || die '拒绝嵌套配置链接'
  fi
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

controller_address() {
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
  [ -n "$VALUE" ] || return 1
  printf '%s\n' "$VALUE"
}

controller_port() {
  VALUE=$(controller_address) || return 1
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

controller_api_url() {
  ADDRESS=$(controller_address) || return 1
  HOST=${ADDRESS%:*}
  PORT=$(controller_port) || return 1
  case "$HOST" in
    0.0.0.0|'') HOST=127.0.0.1 ;;
    '[::]') HOST='[::1]' ;;
  esac
  printf 'http://%s:%s\n' "$HOST" "$PORT"
}

read_api_secret() {
  # Plain/single-quoted secrets, CRLF and trailing comments are supported.
  # Double-quoted escape sequences are intentionally rejected, not guessed.
  awk '
    /^secret:/ {
      sub(/^secret:[[:space:]]*/, ""); sub(/\r$/, "")
      if (substr($0,1,1)=="\047") {
        value=""; rest=substr($0,2)
        while (length(rest)) {
          char=substr(rest,1,1); rest=substr(rest,2)
          if (char=="\047") {
            if (substr(rest,1,1)=="\047") { value=value char; rest=substr(rest,2); continue }
            print value; exit
          }
          value=value char
        }
        exit 1
      }
      if (substr($0,1,1)=="\"") {
        rest=substr($0,2); quoteEnd=index(rest,"\"")
        if (!quoteEnd) exit 1
        value=substr(rest,1,quoteEnd-1)
        if (index(value,"\\")) exit 1
        print value; exit
      }
      sub(/[[:space:]]+#.*/, ""); sub(/[[:space:]]+$/, ""); print; exit
    }
  ' "$CFG" 2>/dev/null
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

# The old fixed sleeps delayed every healthy start, yet could still be too
# short on a busy device. Return as soon as the required state is observable.
wait_healthy() {
  WAIT_TRY=0
  while [ "$WAIT_TRY" -lt 10 ]; do
    health_quiet && return 0
    WAIT_TRY=$((WAIT_TRY + 1))
    [ "$WAIT_TRY" -lt 10 ] && sleep 1
  done
  return 1
}

wait_controller_healthy() {
  WAIT_TRY=0
  while [ "$WAIT_TRY" -lt 10 ]; do
    if health_quiet && controller_reachable; then return 0; fi
    WAIT_TRY=$((WAIT_TRY + 1))
    [ "$WAIT_TRY" -lt 10 ] && sleep 1
  done
  return 1
}

controller_reachable() {
  [ -x "$CURL" ] || return 1
  API_URL=$(controller_api_url) || return 1
  API_SECRET=$(read_api_secret) || return 1
  [ -n "$API_SECRET" ] || return 1
  API_REPLY=$("$CURL" -fsS --connect-timeout 2 --max-time 5 \
    -H "Authorization: Bearer $API_SECRET" \
    "$API_URL/version" 2>/dev/null) || return 1
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

  BACKEND_VERSION=2.6-rc2.3
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
  CONTROLLER_ADDRESS=$(controller_address 2>/dev/null || true)
  MAIN_PENDING=0
  [ -f "$MAIN_REFRESH_PENDING" ] && MAIN_PENDING=1

  printf 'installed=%s\nconfigured=%s\nrunning=%s\npid=%s\nboot=%s\nui=%s\nipv4=%s\nipv6=%s\nmain_refresh_pending=%s\ncontroller_port=%s\nlog_bytes=%s\nboot_log_bytes=%s\nbackend=%s\nversion=%s\n' \
    "$INSTALLED" "$CONFIGURED" "$RUNNING" "$PID" "$BOOT" "$UI" "$IPV4" "$IPV6" \
    "$MAIN_PENDING" "$CONTROLLER_PORT" "$LOG_BYTES" "$BOOT_LOG_BYTES" "$BACKEND_VERSION" "$VERSION"
  say "controller_address=$CONTROLLER_ADDRESS"
  CONFIG_TARGET=$(readlink "$CFG" 2>/dev/null || true)
  say "config_name=${CONFIG_TARGET:-${CFG##*/}}"
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
  "$BIN" -t -d "$BASE" -f "$CFG" || die '当前配置校验失败，未停止现有服务'
  "$SCRIPTS/stop.sh" || die '停止 Mihomo 失败'
  "$SCRIPTS/start.sh" --validated-config || die 'Mihomo 启动失败'
  wait_healthy || die "重启后健康检查未通过"
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

config_read_action() {
  [ -f "$CFG" ] || die "当前配置不存在"
  [ "$(file_size "$CFG")" -le 3145728 ] 2>/dev/null || die "当前配置超过 3 MB，拒绝发送到浏览器"
  cat "$CFG" || die "读取配置失败"
}

config_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    CONFIG_HASH_OUT=$(sha256sum < "$1") || return 1
  elif command -v toybox >/dev/null 2>&1; then
    CONFIG_HASH_OUT=$(toybox sha256sum < "$1") || return 1
  else
    return 1
  fi
  CONFIG_HASH=$(printf '%s\n' "$CONFIG_HASH_OUT" | awk 'NR==1 {print $1}')
  printf '%s' "$CONFIG_HASH" | grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s\n' "$CONFIG_HASH"
}

# Compare only the direct main.url field in this project's provider layout.
# Keep the URL in process memory: never write it to logs or command output.
main_url_field() {
  awk '
    /^proxy-providers:[[:space:]]*(#.*)?$/ { providers=1; next }
    providers && /^[^[:space:]#]/ { exit }
    providers && /^  main:[[:space:]]*(#.*)?$/ { main=1; next }
    main && /^  [^[:space:]#]/ { exit }
    main && /^    url:[[:space:]]*/ {
      sub(/^    url:[[:space:]]*/, "")
      sub(/\r$/, "")
      print
      exit
    }
  ' "$1"
}

# v1.19.31 ApplyConfig updates DNS/rules/providers but excludes the controller.
# These fields also affect our external firewall or listening sockets.
reload_boundary() {
  awk '
    /^[^[:space:]#]/ { dns=0; block=0 }
    /^dns:[[:space:]]*/ { dns=1; next }
    /^(external-controller[^:]*|secret|tproxy-port|ipv6|tun|interface-name|routing-mark):/ { block=1 }
    block { print; next }
    dns && /^[[:space:]]+(listen|fake-ip-range6):/ { print }
  ' "$1"
}

reload_core() {
  RELOAD_HTTP_STATUS=$("$CURL" --silent --show-error --connect-timeout 3 --max-time 90 \
    --output /dev/null --write-out '%{http_code}' -X PUT \
    -H "Authorization: Bearer $RELOAD_SECRET" -H 'Content-Type: application/json' \
    --data "{\"path\":\"$CFG\"}" "$RELOAD_URL/configs?force=true") || return 1
  [ "$RELOAD_HTTP_STATUS" = 204 ]
}

config_apply_action() {
  acquire_lock
  require_base
  case "${2:-}" in
    '') REFRESH_MAIN=0 ;;
    REFRESH_MAIN) REFRESH_MAIN=1 ;;
    AUTO_REFRESH_MAIN) REFRESH_MAIN=2 ;;
    *) die '配置应用选项无效' ;;
  esac
  EXPECTED_SHA=${3:-}
  if [ -n "$EXPECTED_SHA" ]; then
    printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-f]{64}$' || die '上传配置 SHA-256 参数无效'
  fi
  EXPECTED_OLD_SHA=${4:-}
  if [ -n "$EXPECTED_OLD_SHA" ]; then
    printf '%s' "$EXPECTED_OLD_SHA" | grep -Eq '^[0-9a-f]{64}$' || die '原配置 SHA-256 参数无效'
  fi
  MAIN_PENDING_BEFORE=0
  [ -f "$MAIN_REFRESH_PENDING" ] && MAIN_PENDING_BEFORE=1
  WAS_PENDING=0
  [ -f "$PENDING_MARKER" ] && WAS_PENDING=1
  SOURCE="${1:-}"
  check_upload_path "$SOURCE"

  TEMP="$BASE/config/.MiConfig-upload.$$"
  NEWCFG="$BASE/config/.MiConfig-new.$$"
  SAFETY="$BASE/config/.MiConfig-safety.$$"
  INDEX_TEMP="$BASE/config/.current.$$"
  RESTORE_TEMP="$BASE/config/.MiConfig-restore.$$"
  OLD_INDEX=$(readlink "$CFG" 2>/dev/null || true)
  OLD_CFG=$CFG
  if [ -n "$OLD_INDEX" ]; then OLD_CFG=$BASE/config/$OLD_INDEX; fi
  KEEP_SAFETY=0
  CLEAN_SOURCE="$SOURCE"

  cleanup_apply() {
    rm -f "$TEMP" "$NEWCFG" "$INDEX_TEMP" "$RESTORE_TEMP" "$CLEAN_SOURCE" 2>/dev/null || true
    [ "$KEEP_SAFETY" -eq 1 ] || rm -f "$SAFETY" 2>/dev/null || true
  }
  trap 'cleanup_apply; release_lock' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  cp "$SOURCE" "$TEMP" || die "复制上传配置失败"
  chmod 600 "$TEMP" 2>/dev/null || true
  UPLOADED_SHA=$(config_sha256 "$TEMP") || die '无法校验上传配置 SHA-256'
  if [ -n "$EXPECTED_SHA" ] && [ "$UPLOADED_SHA" != "$EXPECTED_SHA" ]; then
    die '设备收到的配置与本次选择的文件不一致；未停止服务或替换现有配置'
  fi
  if [ -n "$EXPECTED_OLD_SHA" ]; then
    CURRENT_SHA=$(config_sha256 "$CFG") || die '无法读取原配置 SHA-256'
    [ "$CURRENT_SHA" = "$EXPECTED_OLD_SHA" ] || die '配置已被其他操作修改；未覆盖，请重新打开编辑窗口'
  fi
  if [ "$REFRESH_MAIN" -eq 2 ]; then
    OLD_MAIN_URL=$(main_url_field "$CFG")
    NEW_MAIN_URL=$(main_url_field "$TEMP")
    REFRESH_MAIN=0
    [ -n "$NEW_MAIN_URL" ] && { [ "$NEW_MAIN_URL" != "$OLD_MAIN_URL" ] || [ "$MAIN_PENDING_BEFORE" -eq 1 ]; } && REFRESH_MAIN=1
  fi
  MAIN_CACHE_BEFORE=0
  [ -s "$BASE/providers/main.yaml" ] && MAIN_CACHE_BEFORE=1
  HOT_RELOAD=0
  if [ "$WAS_PENDING" -eq 0 ] && health_quiet && controller_reachable; then
    if [ "$(reload_boundary "$CFG")" = "$(reload_boundary "$TEMP")" ]; then
      RELOAD_URL=$(controller_api_url) || die '无法读取控制器地址'
      RELOAD_SECRET=$API_SECRET
      HOT_RELOAD=1
    fi
  fi
  if [ "$HOT_RELOAD" -eq 0 ]; then
    "$BIN" -t -d "$BASE" -f "$TEMP" || die "上传配置校验失败"
  fi

  cp "$TEMP" "$NEWCFG" || die "准备新配置失败"
  chmod 600 "$NEWCFG" 2>/dev/null || true
  cp "$CFG" "$SAFETY" || die '创建临时配置保护副本失败'
  chmod 600 "$SAFETY" 2>/dev/null || true
  NEW_NAME=MiConfig-$(date +%Y%m%d%H%M).yaml
  printf '%s' "$NEW_NAME" | grep -Eq '^MiConfig-[0-9]{12}\.yaml$' || die '无法生成配置应用时间'
  NEW_PATH=$BASE/config/$NEW_NAME
  [ ! -L "$NEW_PATH" ] || die '拒绝符号链接配置目标'
  [ ! -d "$NEW_PATH" ] || die '配置目标不是普通文件'
  if [ "$REFRESH_MAIN" -eq 1 ]; then touch "$MAIN_REFRESH_PENDING" || die '无法标记 main 订阅待刷新状态'; fi
  if [ "$HOT_RELOAD" -eq 0 ]; then "$SCRIPTS/stop.sh" || die '停止 Mihomo 失败'; fi
  PUBLISHED=0
  if mv "$NEWCFG" "$NEW_PATH"; then
    # Same-minute saves reuse the existing alias; replace only its target's
    # contents. This avoids redundant renames of links to the same file.
    if [ "$(readlink "$CFG" 2>/dev/null || true)" = "$NEW_NAME" ]; then
      PUBLISHED=1
    elif ln -s "$NEW_NAME" "$INDEX_TEMP" && mv -f "$INDEX_TEMP" "$CFG"; then
      PUBLISHED=1
    fi
  fi

  START_OK=0
  STARTED=0
  FAIL_REASON='新配置提交或双栈/控制器健康检查失败'
  # This exact configuration was already checked above. Avoid parsing and
  # loading geodata a second time during the same locked transaction.
  if [ "$PUBLISHED" -eq 1 ]; then
    if [ "$HOT_RELOAD" -eq 1 ]; then
      reload_core && STARTED=1
      if [ "$STARTED" -eq 0 ]; then FAIL_REASON="配置热加载失败（HTTP ${RELOAD_HTTP_STATUS:-000}）"; fi
      # Old/embed runtimes may lack this endpoint; use the normal path then.
      case "${RELOAD_HTTP_STATUS:-}" in
        404|405|501)
          if "$BIN" -t -d "$BASE" -f "$CFG"; then
            HOT_RELOAD=0
            "$SCRIPTS/stop.sh" && "$SCRIPTS/start.sh" --validated-config && STARTED=1
          fi
          ;;
      esac
    else
      "$SCRIPTS/start.sh" --validated-config && STARTED=1
    fi
  fi
  if [ "$STARTED" -eq 1 ]; then wait_controller_healthy && START_OK=1; fi
  if [ "$START_OK" -eq 1 ] && [ "$REFRESH_MAIN" -eq 1 ]; then
    if refresh_main_now; then
      rm -f "$MAIN_REFRESH_PENDING" || die 'main 已刷新，但无法清除待刷新状态'
    else
      START_OK=0
      FAIL_REASON="main 订阅刷新失败（$MAIN_REFRESH_ERROR）"
    fi
  fi

  if [ "$START_OK" -eq 1 ]; then
    APPLIED_SHA=$(config_sha256 "$CFG") || APPLIED_SHA=''
    if [ "$APPLIED_SHA" != "$UPLOADED_SHA" ]; then
      START_OK=0
      FAIL_REASON='正式配置与本次上传的文件不一致'
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
    say "config_sha256=$APPLIED_SHA"
    say "config_name=$NEW_NAME"
    say "controller_address=$(controller_address)"
    say "controller_port=$(controller_port)"
    say 'running=1'
    say 'ipv4=1'
    say 'ipv6=1'
    say 'health_confirmed=1'
    say 'configured=1'
    say 'installed=1'
    say "pid=$(pid_value)"
    if grep -Fq "$BOOT_MATCH" "$BOOT_FILE" 2>/dev/null; then say 'boot=1'; else say 'boot=0'; fi
    say 'main_refresh_pending=0'
    if [ "$HOT_RELOAD" -eq 1 ]; then say 'apply_mode=reload'; else say 'apply_mode=restart'; fi
    say "main_refreshed=$REFRESH_MAIN"
    say "main_cache_before=$MAIN_CACHE_BEFORE"
    # Keep one dated file and a stable alias, not a second config copy.
    if [ "$OLD_CFG" != "$CFG" ] && [ "$OLD_CFG" != "$NEW_PATH" ]; then rm -f "$OLD_CFG" 2>/dev/null || true; fi
    for OBSOLETE in "$BASE/config"/MiConfig-*.yaml; do
      [ -f "$OBSOLETE" ] && [ ! -L "$OBSOLETE" ] || continue
      [ "$OBSOLETE" = "$NEW_PATH" ] && continue
      printf '%s' "${OBSOLETE##*/}" | grep -Eq '^MiConfig-[0-9]{12}\.yaml$' || continue
      rm -f "$OBSOLETE" 2>/dev/null || true
    done
    exit 0
  fi

  if [ "$HOT_RELOAD" -eq 0 ]; then "$SCRIPTS/stop.sh" >/dev/null 2>&1 || true; fi
  if ! cp "$SAFETY" "$RESTORE_TEMP" || ! mv "$RESTORE_TEMP" "$OLD_CFG"; then
    KEEP_SAFETY=1
    die "新配置失败，且无法恢复；保护副本保留在 $SAFETY"
  fi
  if [ -n "$OLD_INDEX" ] && [ "$(readlink "$CFG" 2>/dev/null || true)" != "$OLD_INDEX" ]; then
    rm -f "$INDEX_TEMP" || { KEEP_SAFETY=1; die '无法准备恢复配置链接'; }
    if ! ln -s "$OLD_INDEX" "$INDEX_TEMP" || ! mv -f "$INDEX_TEMP" "$CFG"; then
      KEEP_SAFETY=1
      die '恢复配置链接失败'
    fi
  fi
  [ "$NEW_PATH" = "$OLD_CFG" ] || rm -f "$NEW_PATH" 2>/dev/null || true
  chmod 600 "$CFG" 2>/dev/null || true
  if [ "$REFRESH_MAIN" -eq 1 ] && [ "$MAIN_PENDING_BEFORE" -eq 0 ]; then
    rm -f "$MAIN_REFRESH_PENDING" 2>/dev/null || true
  fi
  if [ "$WAS_PENDING" -eq 0 ]; then
    if [ "$HOT_RELOAD" -eq 1 ] && reload_core && wait_controller_healthy; then
      :
    else
      "$SCRIPTS/stop.sh" >/dev/null 2>&1 || true
      "$SCRIPTS/start.sh" >/dev/null 2>&1 || true
    fi
  fi
  die "$FAIL_REASON，已尝试恢复操作前配置"
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

api_info() {
  SECRET=$(read_api_secret) || die '无法解析控制器密钥格式'
  [ -n "$SECRET" ] || die "无法读取 Mihomo API 密码"
  API_URL=$(controller_api_url) || die '无法从 external-controller 读取 API 地址'
}

provider_status_action() {
  require_base
  require_configured
  is_running || die 'Mihomo 未运行，无法检查订阅加载状态'
  [ -x "$CURL" ] || die '未找到 UFI-Tools curl'
  api_info
  "$CURL" -fsS --connect-timeout 5 --max-time 20 \
    -H "Authorization: Bearer $SECRET" \
    "$API_URL/providers/proxies/main" || \
    die '无法从 Mihomo 控制器读取 main 订阅状态'
}

# GET only proves that some nodes are in memory; after main.url changes they
# may still be from providers/main.yaml. PUT forces Mihomo to fetch the active
# URL and returns 204 only after the update succeeds. Discard the response body
# because it could contain subscription metadata.
refresh_main_now() {
  MAIN_REFRESH_ERROR='未知错误'
  if [ ! -x "$CURL" ]; then MAIN_REFRESH_ERROR='未找到 UFI-Tools curl'; return 1; fi
  API_URL=$(controller_api_url) || { MAIN_REFRESH_ERROR='无法读取控制器地址'; return 1; }
  API_SECRET=$(read_api_secret) || { MAIN_REFRESH_ERROR='无法解析控制器密钥格式'; return 1; }
  if [ -z "$API_SECRET" ]; then MAIN_REFRESH_ERROR='无法读取控制器密钥'; return 1; fi
  HTTP_STATUS=$("$CURL" --silent --show-error --connect-timeout 3 --max-time 50 \
    --output /dev/null --write-out '%{http_code}' -X PUT \
    -H "Authorization: Bearer $API_SECRET" \
    "$API_URL/providers/proxies/main") || {
    MAIN_REFRESH_ERROR='网络请求失败或超时'
    return 1
  }
  if [ "$HTTP_STATUS" != '204' ]; then
    MAIN_REFRESH_ERROR="HTTP $HTTP_STATUS"
    return 1
  fi
  return 0
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
  stop) stop_action ;;
  restart) restart_action ;;
  boot-enable) boot_enable_action ;;
  boot-disable) boot_disable_action ;;
  config-read) config_read_action ;;
  config-apply) config_apply_action "${1:-}" "${2:-}" "${3:-}" "${4:-}" ;;
  boot-log) boot_log_action ;;
  mihomo-log) mihomo_log_action ;;
  provider-status) provider_status_action ;;
  uninstall) uninstall_action "${1:-}" ;;
  *) die "不支持的动作：$ACTION" ;;
esac
