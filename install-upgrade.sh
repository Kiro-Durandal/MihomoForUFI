#!/system/bin/sh

# Transactional Mihomo 2.6-RC2.3 dual-stack upgrade.
# Default: install, restart, verify, and automatically roll back on failure.
# Use --stage-only to install without restarting the currently running service.

set -u

D=$(dirname "$0")
BASE=/data/f50-mihomo
SCRIPTS=$BASE/scripts
BIN=$BASE/bin/mihomo
CFG=$BASE/config/config.yaml
INSTALL_LOCK=$BASE/run/install-v26.lock
LAST_BACKUP=$BASE/run/last-v26-upgrade-backup
FILES='env.sh firewall-start.sh firewall-stop.sh start.sh stop.sh status.sh boot-start.sh uninstall.sh ufi-backend.sh'
BACKUP_READY=0
BACKUP_DIR=''

say() { printf '%s\n' "$*"; }

release_lock() {
  rm -f "$INSTALL_LOCK/pid" 2>/dev/null || true
  rmdir "$INSTALL_LOCK" 2>/dev/null || true
}

discard_upgrade_backup() {
  # Only the copy created by this invocation; older user backups are untouched.
  case "$BACKUP_DIR" in "$BASE"/backups/upgrade-v26-[0-9]*) ;; *) return 1 ;; esac
  [ ! -L "$BACKUP_DIR" ] || return 1
  if [ "$(sed -n '1p' "$LAST_BACKUP" 2>/dev/null || true)" = "$BACKUP_DIR" ]; then rm -f "$LAST_BACKUP"; fi
  rm -rf "$BACKUP_DIR"
}

acquire_lock() {
  if mkdir "$INSTALL_LOCK" 2>/dev/null; then
    printf '%s\n' "$$" > "$INSTALL_LOCK/pid"
    return 0
  fi

  OLD_PID=$(sed -n '1p' "$INSTALL_LOCK/pid" 2>/dev/null || true)
  case "$OLD_PID" in
    ''|*[!0-9]*) OLD_PID='' ;;
  esac
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    die "另一个 2.6 升级或回退操作正在运行（PID $OLD_PID）"
  fi

  rm -f "$INSTALL_LOCK/pid" 2>/dev/null || true
  rmdir "$INSTALL_LOCK" 2>/dev/null || die "发现无法自动清理的升级锁：$INSTALL_LOCK"
  mkdir "$INSTALL_LOCK" 2>/dev/null || die '无法取得升级锁'
  printf '%s\n' "$$" > "$INSTALL_LOCK/pid"
}

restore_files() {
  [ "$BACKUP_READY" -eq 1 ] || return 0
  for NAME in $FILES; do
    if [ -f "$BACKUP_DIR/$NAME" ]; then
      cp "$BACKUP_DIR/$NAME" "$SCRIPTS/.$NAME.restore.$$" || return 1
      chmod 700 "$SCRIPTS/.$NAME.restore.$$" 2>/dev/null || true
      mv "$SCRIPTS/.$NAME.restore.$$" "$SCRIPTS/$NAME" || return 1
    elif [ -f "$BACKUP_DIR/.missing-$NAME" ]; then
      rm -f "$SCRIPTS/$NAME" || return 1
    fi
  done
}

die() {
  say "ERROR: $*" >&2
  if [ "$BACKUP_READY" -eq 1 ]; then
    say '正在恢复升级前脚本……' >&2
    restore_files || say "ERROR: 自动恢复脚本失败；备份位于 $BACKUP_DIR" >&2
  fi
  exit 1
}

source_for() {
  case "$1" in
    ufi-backend.sh) printf '%s/ufi-backend.sh\n' "$D" ;;
    *) printf '%s/scripts/%s\n' "$D" "$1" ;;
  esac
}

read_config_value() {
  KEY=$1
  awk -v wanted="$KEY" '
    $0 ~ "^[[:space:]]*" wanted "[[:space:]]*:" {
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
  ' "$CFG" 2>/dev/null
}

[ "$(id -u 2>/dev/null)" = "0" ] || die '请在 UFI-Tools TTYD 的 Root 环境执行'
[ -d "$SCRIPTS" ] || die "未找到 $SCRIPTS"
[ -x "$BIN" ] || die "未找到可执行 Mihomo：$BIN"
[ -f "$CFG" ] || die "未找到配置：$CFG"
PENDING_UPGRADE=0
if [ "${1:-}" = '--pending' ]; then
  [ -f "$BASE/run/setup-pending" ] || die '待配置升级模式缺少 setup-pending 标记'
  grep -q '    url: __SUBSCRIPTION_URL__' "$CFG" || die '待配置标记与订阅占位符不一致，拒绝升级'
  PENDING_UPGRADE=1
fi

mkdir -p "$BASE/run" "$BASE/backups" || die '无法创建升级工作目录'
acquire_lock
trap release_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

say '== 只读预检 =='
for NAME in $FILES; do
  SOURCE=$(source_for "$NAME")
  [ -f "$SOURCE" ] || die "升级包缺少 $SOURCE"
  sh -n "$SOURCE" || die "$NAME 语法校验失败"
  say "OK: $NAME"
done

ip6tables -t mangle -S >/dev/null 2>&1 || die '设备缺少 IPv6 mangle 表'
grep -qx 'TPROXY' /proc/net/ip6_tables_targets 2>/dev/null || die '设备内核缺少 IPv6 TPROXY target'

TOP_IPV6=$(awk -F':[[:space:]]*' '/^ipv6[[:space:]]*:/ {print $2; exit}' "$CFG" 2>/dev/null | tr -d " '\"\r")
[ "$TOP_IPV6" = 'true' ] || die '配置顶层 ipv6 不是 true'

DNS_IPV6=$(awk -F':[[:space:]]*' '
  /^dns[[:space:]]*:/ {in_dns=1; next}
  /^[^[:space:]]/ {in_dns=0}
  in_dns && /^[[:space:]]+ipv6[[:space:]]*:/ {print $2; exit}
' "$CFG" 2>/dev/null | tr -d " '\"\r")
[ "$DNS_IPV6" = 'true' ] || die '配置中的 dns.ipv6 不是 true'

FAKE_IP6_RANGE=$(read_config_value fake-ip-range6)
case "$FAKE_IP6_RANGE" in
  *:*/*) say "OK: fake-ip-range6=$FAKE_IP6_RANGE" ;;
  *) die '配置缺少有效的 dns.fake-ip-range6' ;;
esac

if [ "$PENDING_UPGRADE" -eq 0 ]; then
  "$BIN" -t -d "$BASE" -f "$CFG" || die '当前 Mihomo 配置校验失败'
else
  say 'INFO: 待配置后端保留订阅占位符；跳过尚无法执行的 Mihomo 配置校验。'
fi

STAMP=$(date +%s 2>/dev/null || echo 0)$$
BACKUP_DIR=$BASE/backups/upgrade-v26-$STAMP
mkdir "$BACKUP_DIR" || die '无法创建升级备份目录'

for NAME in $FILES; do
  if [ -f "$SCRIPTS/$NAME" ]; then
    cp "$SCRIPTS/$NAME" "$BACKUP_DIR/$NAME" || die "备份 $NAME 失败"
    chmod 600 "$BACKUP_DIR/$NAME" 2>/dev/null || true
  else
    : > "$BACKUP_DIR/.missing-$NAME" || die "记录新增文件 $NAME 失败"
    chmod 600 "$BACKUP_DIR/.missing-$NAME" 2>/dev/null || true
  fi
done
BACKUP_READY=1
printf '%s\n' "$BACKUP_DIR" > "$LAST_BACKUP" || die '无法记录回退点'
chmod 600 "$LAST_BACKUP" 2>/dev/null || true
say "升级前脚本已备份：$BACKUP_DIR"

for NAME in $FILES; do
  SOURCE=$(source_for "$NAME")
  TEMP=$SCRIPTS/.$NAME.new.$$
  cp "$SOURCE" "$TEMP" || die "复制 $NAME 失败"
  chmod 700 "$TEMP" || die "设置 $NAME 权限失败"
  mv "$TEMP" "$SCRIPTS/$NAME" || die "安装 $NAME 失败"
done

BACKUP_READY=0
say 'Beta 2.6-RC2.3 脚本已原子安装；现有 config.yaml 未作任何修改。'

if [ "$PENDING_UPGRADE" -eq 1 ]; then
  discard_upgrade_backup || say 'WARN: 临时升级副本未能清理'
  say '待配置后端升级完成；保持 Mihomo 停止，不设置开机自启。'
  exit 0
fi

if [ "${1:-}" = '--stage-only' ]; then
  discard_upgrade_backup || say 'WARN: 临时升级副本未能清理'
  say '已按 stage-only 模式保留当前进程。下次重启 Mihomo 时启用 RC2.3 脚本。'
  exit 0
fi

say '== 首次双栈重启与健康检查 =='
if OUTPUT=$(sh "$SCRIPTS/ufi-backend.sh" restart 2>&1); then
  say "$OUTPUT"
  say '升级成功：IPv4 与 IPv6 TProxy 健康检查均已通过。'
  discard_upgrade_backup || say 'WARN: 临时升级副本未能清理'
  exit 0
fi

say "$OUTPUT" >&2
say '双栈启动失败，开始自动恢复升级前脚本……' >&2
sh "$SCRIPTS/stop.sh" >/dev/null 2>&1 || true
BACKUP_READY=1
restore_files || die "恢复旧脚本失败；请从 $BACKUP_DIR 手动恢复"
BACKUP_READY=0

if sh "$SCRIPTS/start.sh"; then
  say '已自动恢复升级前脚本与运行状态。2.6-RC2.3 未生效。' >&2
else
  say "ERROR: 旧版脚本已恢复，但重新启动失败。备份位于 $BACKUP_DIR" >&2
fi
exit 1
