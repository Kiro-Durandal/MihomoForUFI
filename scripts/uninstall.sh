#!/system/bin/sh

# Irreversible Mihomo backend removal. This intentionally keeps the
# UFI-Tools front-end registration and downloaded release package untouched.

set -u

BASE=/data/f50-mihomo
BOOT_FILE=/sdcard/ufi_tools_boot.sh
BOOT_MATCH=/data/f50-mihomo/scripts/boot-start.sh
BOOT_LOG=/data/local/tmp/f50_mihomo_boot.log
UNINSTALL_LOCK=/data/local/tmp/f50-mihomo-uninstall.lock
GLOBAL_INSTALL_LOCK=/data/local/tmp/f50-mihomo-rc2-install.lock
UPGRADE_LOCK=$BASE/run/install-v26.lock
SELF_DELETE=0

[ "${1:-}" = '--self-delete' ] && SELF_DELETE=1

say() { printf '%s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

lock_pid_is_live() {
  LOCK_PATH=$1
  [ -d "$LOCK_PATH" ] || return 1
  LOCK_PID=$(sed -n '1p' "$LOCK_PATH/pid" 2>/dev/null || true)
  case "$LOCK_PID" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$LOCK_PID" 2>/dev/null
}

cleanup() {
  rmdir "$UNINSTALL_LOCK" 2>/dev/null || true
  if [ "$SELF_DELETE" -eq 1 ]; then
    case "$0" in
      /data/local/tmp/f50-mihomo-uninstall.[0-9]*.sh) rm -f "$0" 2>/dev/null || true ;;
    esac
  fi
}

[ "$(id -u 2>/dev/null)" = '0' ] || die '请在 UFI-Tools TTYD 的 Root 环境执行'
[ "$BASE" = '/data/f50-mihomo' ] || die '拒绝卸载：后端目录不是预期的绝对路径'
[ -d "$BASE" ] || die '未找到 Mihomo 后端目录'
[ ! -L "$BASE" ] || die '拒绝卸载符号链接目录'
[ -f "$BASE/scripts/stop.sh" ] || die '缺少 stop.sh，无法安全清理代理规则'
[ -f "$BASE/scripts/firewall-stop.sh" ] || die '缺少 firewall-stop.sh，无法安全清理代理规则'

if lock_pid_is_live "$GLOBAL_INSTALL_LOCK"; then
  die '全新安装正在运行，拒绝并发卸载'
fi
if lock_pid_is_live "$UPGRADE_LOCK"; then
  die '升级或回退正在运行，拒绝并发卸载'
fi

mkdir "$UNINSTALL_LOCK" 2>/dev/null || die '另一个卸载操作正在运行'
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

say '== 停止服务并清理双栈规则 =='
sh "$BASE/scripts/stop.sh" || die '停止 Mihomo 失败'
sh "$BASE/scripts/firewall-stop.sh" || die '清理 IPv4/IPv6 TProxy 规则失败'
# Table 2022 is reserved by this package. Flush it even if an interrupted old
# install lost its ownership marker before uninstall began.
ip route flush table 2022 2>/dev/null || true
ip -6 route flush table 2022 2>/dev/null || true

for PROC_DIR in /proc/[0-9]*; do
  PROC_PID=${PROC_DIR##*/}
  EXE=$(readlink "$PROC_DIR/exe" 2>/dev/null || true)
  CMDLINE=$(tr '\000' ' ' < "$PROC_DIR/cmdline" 2>/dev/null || true)
  if [ "$EXE" = "$BASE/bin/mihomo" ]; then
    die "Mihomo 进程 $PROC_PID 仍在运行，已中止删除"
  fi
  case "$CMDLINE" in
    "$BASE/bin/mihomo"|"$BASE/bin/mihomo "*) die "Mihomo 进程 $PROC_PID 仍在运行，已中止删除" ;;
  esac
done

iptables -t mangle -S F50_MIHOMO >/dev/null 2>&1 && die 'IPv4 TProxy 链仍存在，已中止删除'
iptables -t nat -S F50_MIHOMO_DNS >/dev/null 2>&1 && die 'IPv4 DNS 链仍存在，已中止删除'
ip6tables -t mangle -S F50_MIHOMO6 >/dev/null 2>&1 && die 'IPv6 TProxy 链仍存在，已中止删除'
ip rule show 2>/dev/null | grep 'fwmark 0x40000000/0x40000000.*lookup 2022' >/dev/null && die 'IPv4 策略路由仍存在，已中止删除'
ip -6 rule show 2>/dev/null | grep 'fwmark 0x40000000/0x40000000.*lookup 2022' >/dev/null && die 'IPv6 策略路由仍存在，已中止删除'
[ -z "$(ip route show table 2022 2>/dev/null)" ] || die 'IPv4 路由表 2022 仍有残留，已中止删除'
[ -z "$(ip -6 route show table 2022 2>/dev/null)" ] || die 'IPv6 路由表 2022 仍有残留，已中止删除'

if [ -f "$BOOT_FILE" ]; then
  [ ! -L "$BOOT_FILE" ] || die '开机脚本是符号链接，拒绝修改'
  sed -i "\#$BOOT_MATCH#d" "$BOOT_FILE" || die '取消开机自启失败'
  grep -Fq "$BOOT_MATCH" "$BOOT_FILE" 2>/dev/null && die '开机自启记录仍存在，已中止删除'
fi

say '== 永久删除后端数据 =='
rm -rf "$BASE" || die "无法删除 $BASE"
[ ! -e "$BASE" ] || die "$BASE 删除后仍存在"

for LEFTOVER in /data/f50-mihomo.install.* /data/f50-mihomo.failed.*; do
  [ -e "$LEFTOVER" ] || [ -L "$LEFTOVER" ] || continue
  case "$LEFTOVER" in
    /data/f50-mihomo.install.[0-9]*|/data/f50-mihomo.failed.[0-9]*) ;;
    *) continue ;;
  esac
  if [ -L "$LEFTOVER" ]; then
    rm -f "$LEFTOVER" || die "无法删除遗留链接 $LEFTOVER"
  else
    rm -rf "$LEFTOVER" || die "无法删除遗留目录 $LEFTOVER"
  fi
done

rm -f "$BOOT_LOG" 2>/dev/null || true
if [ -d "$GLOBAL_INSTALL_LOCK" ]; then
  rm -f "$GLOBAL_INSTALL_LOCK/pid" 2>/dev/null || true
  rmdir "$GLOBAL_INSTALL_LOCK" 2>/dev/null || true
fi
for OLD_HELPER in /data/local/tmp/f50-mihomo-uninstall.[0-9]*.sh; do
  [ -f "$OLD_HELPER" ] || continue
  [ "$OLD_HELPER" = "$0" ] || rm -f "$OLD_HELPER" 2>/dev/null || true
done
say 'OK: Mihomo 后端、配置、节点缓存、日志、备份和双栈规则已永久删除。'
say '请在 UFI-Tools 脚本管理中手动删除 RC2 前端 JS。'
