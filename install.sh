#!/system/bin/sh

# Unified installer for F50 Mihomo Beta 2.6-RC2.2.
# - Fresh install without a subscription: commits the backend and template in
#   a pending state. Applying a valid configuration starts Mihomo later.
# - Fresh install with a complete configuration: validates, commits, starts,
#   verifies dual-stack TProxy, then enables boot startup.
# - Existing install: delegates to the transactional RC2 upgrade path and
#   preserves config.yaml, providers, logs, UI and the Mihomo binary.

set -u

D=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd) || exit 1
VERSION=2.6-RC2.2
BASE=/data/f50-mihomo
BIN=$BASE/bin/mihomo
CFG=$BASE/config/config.yaml
BOOT_FILE=/sdcard/ufi_tools_boot.sh
BOOT_MATCH=/data/f50-mihomo/scripts/boot-start.sh
BOOT_COMMAND='sh /data/f50-mihomo/scripts/boot-start.sh >/dev/null 2>&1 &'

MODE=auto
CONFIG_SOURCE=''
SUBSCRIPTION_FILE=''
START_AFTER=1
ENABLE_BOOT=1
STAGE=''
INSTALL_LOCK=/data/local/tmp/f50-mihomo-rc2-install.lock
PENDING_MARKER=run/setup-pending

say() { printf '%s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  sh install.sh [--fresh|--upgrade] [options]

Fresh-install options:
  --subscription-file PATH  Optional file whose first line is the HTTPS subscription URL
  --config PATH             Use a complete config.yaml instead of the template
  --no-start                With a complete config, validate but do not start
  --no-boot                 Do not add the UFI-Tools boot-start entry

Existing installations automatically use the transactional upgrade path and
preserve the current configuration and runtime data.
Without --subscription-file or --config, the backend is installed without
starting Mihomo. Complete setup from the front-end subscription dialog.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fresh) MODE=fresh ;;
    --upgrade) MODE=upgrade ;;
    --subscription-file)
      [ "$#" -ge 2 ] || die '--subscription-file 缺少路径'
      SUBSCRIPTION_FILE=$2
      shift
      ;;
    --config)
      [ "$#" -ge 2 ] || die '--config 缺少路径'
      CONFIG_SOURCE=$2
      shift
      ;;
    --no-start) START_AFTER=0 ;;
    --no-boot) ENABLE_BOOT=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
  shift
done

[ "$(id -u 2>/dev/null)" = "0" ] || die '请在 UFI-Tools Root 环境执行'

release_install_lock() {
  rm -f "$INSTALL_LOCK/pid" 2>/dev/null || true
  rmdir "$INSTALL_LOCK" 2>/dev/null || true
}

cleanup_all() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then
    rm -rf "$STAGE"
  fi
  release_install_lock
}

acquire_install_lock() {
  if mkdir "$INSTALL_LOCK" 2>/dev/null; then
    printf '%s\n' "$$" > "$INSTALL_LOCK/pid"
    return 0
  fi
  OLD_PID=$(sed -n '1p' "$INSTALL_LOCK/pid" 2>/dev/null || true)
  case "$OLD_PID" in
    ''|*[!0-9]*) OLD_PID='' ;;
  esac
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    die "另一个 RC2 安装正在运行（PID $OLD_PID）"
  fi
  rm -f "$INSTALL_LOCK/pid" 2>/dev/null || true
  rmdir "$INSTALL_LOCK" 2>/dev/null || die "无法清理陈旧安装锁：$INSTALL_LOCK"
  mkdir "$INSTALL_LOCK" 2>/dev/null || die '无法取得 RC2 安装锁'
  printf '%s\n' "$$" > "$INSTALL_LOCK/pid"
}

acquire_install_lock
trap cleanup_all EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

is_complete_install() {
  [ -x "$BIN" ] && [ -f "$CFG" ] && [ -d "$BASE/scripts" ]
}

if [ "$MODE" = auto ]; then
  if is_complete_install; then MODE=upgrade; else MODE=fresh; fi
fi

if [ "$MODE" = upgrade ]; then
  is_complete_install || die '未检测到可升级的完整安装；请使用全新安装'
  [ -f "$D/install-upgrade.sh" ] || die '发布包缺少 install-upgrade.sh'
  say "检测到现有安装，进入 $VERSION 事务式升级。"
  if [ -f "$BASE/$PENDING_MARKER" ]; then
    sh "$D/install-upgrade.sh" --pending || exit $?
    say '待配置后端已升级；请在前端填写订阅链接，现有配置仍未修改。'
    exit 0
  fi
  if [ "$START_AFTER" -eq 1 ]; then
    sh "$D/install-upgrade.sh"
  else
    sh "$D/install-upgrade.sh" --stage-only
  fi
  if [ "$ENABLE_BOOT" -eq 1 ]; then
    sh "$BASE/scripts/ufi-backend.sh" boot-enable
  fi
  [ -z "$SUBSCRIPTION_FILE" ] || say 'INFO: 升级模式保留现有配置，未使用首次安装订阅文件。'
  exit 0
fi

[ "$MODE" = fresh ] || die "内部安装模式无效：$MODE"
if [ -e "$BASE" ]; then
  die "$BASE 已存在但不是完整安装；为避免覆盖数据，请先人工检查该目录"
fi

REQUIRED_FILES='ufi-backend.sh scripts/env.sh scripts/firewall-start.sh scripts/firewall-stop.sh scripts/start.sh scripts/stop.sh scripts/status.sh scripts/boot-start.sh'
for REL in $REQUIRED_FILES; do
  [ -f "$D/$REL" ] || die "发布包缺少 $REL"
  sh -n "$D/$REL" || die "$REL 语法校验失败"
done
[ -f "$D/config/config.template.yaml" ] || die '发布包缺少 config/config.template.yaml'
[ -f "$D/runtime/mihomo" ] || die '发布包缺少 runtime/mihomo；仓库源码包不能直接用于全新安装'

ABI=$(getprop ro.product.cpu.abi 2>/dev/null || true)
case "$ABI" in
  arm64-v8a|arm64*|aarch64*) ;;
  *) die "不支持的设备架构：${ABI:-unknown}（RC2 仅支持 arm64）" ;;
esac

ip link show br0 >/dev/null 2>&1 || die '未找到 F50 热点接口 br0'
iptables -t mangle -S >/dev/null 2>&1 || die '设备缺少 IPv4 mangle 表'
ip6tables -t mangle -S >/dev/null 2>&1 || die '设备缺少 IPv6 mangle 表'
grep -qx TPROXY /proc/net/ip_tables_targets 2>/dev/null || die '内核缺少 IPv4 TPROXY target'
grep -qx TPROXY /proc/net/ip6_tables_targets 2>/dev/null || die '内核缺少 IPv6 TPROXY target'

if [ -n "$CONFIG_SOURCE" ]; then
  [ -f "$CONFIG_SOURCE" ] || die "配置文件不存在：$CONFIG_SOURCE"
  [ "$(wc -c < "$CONFIG_SOURCE" 2>/dev/null || echo 99999999)" -le 3145728 ] 2>/dev/null || die '配置文件超过 3 MB'
else
  if [ -n "$SUBSCRIPTION_FILE" ]; then
    [ -f "$SUBSCRIPTION_FILE" ] || die "订阅文件不存在：$SUBSCRIPTION_FILE"
  fi
  grep -q '__REVIEW_REQUIRED__' "$D/config/config.template.yaml" 2>/dev/null && \
    die 'config.template.yaml 尚未完成 DNS/规则/隐私复核；请移除 __REVIEW_REQUIRED__ 标记后再发布'
fi

render_template() {
  TEMPLATE=$1
  TARGET=$2
  URL=$(sed -n '1p' "$SUBSCRIPTION_FILE" 2>/dev/null | tr -d '\r')
  [ -n "$URL" ] || die '订阅文件第一行为空'
  [ "$(printf '%s' "$URL" | wc -c)" -le 4096 ] 2>/dev/null || die '订阅链接超过 4096 字节'
  case "$URL" in
    https://*) ;;
    *) die '首次安装只接受 HTTPS 订阅链接' ;;
  esac
  case "$URL" in
    *\\*) die '订阅链接包含反斜杠' ;;
  esac
  printf '%s' "$URL" | grep -q '[[:space:]]' && die '订阅链接包含空白字符'
  URL_ESCAPED=$(printf '%s' "$URL" | sed "s/'/''/g")

  awk -v url="$URL_ESCAPED" '
    { sub(/\r$/, "") }
    $0 == "    url: __SUBSCRIPTION_URL__" {
      print "    url: \047" url "\047"
      replaced++
      next
    }
    { print }
    END { if (replaced != 1) exit 1 }
  ' "$TEMPLATE" > "$TARGET" || die '生成配置失败'

  if grep -Eq '__[A-Z0-9_]+__' "$TARGET" 2>/dev/null; then
    die '生成后的配置仍含未填写占位符'
  fi
}

STAMP=$(date +%s 2>/dev/null || echo 0)$$
STAGE=/data/f50-mihomo.install.$STAMP
[ ! -e "$STAGE" ] || die "临时目录已存在：$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/config" "$STAGE/providers" "$STAGE/logs" "$STAGE/run" "$STAGE/backups" "$STAGE/scripts" || die '无法创建安装暂存目录'

cp "$D/runtime/mihomo" "$STAGE/bin/mihomo" || die '复制 Mihomo 内核失败'
chmod 700 "$STAGE/bin/mihomo" || die '设置 Mihomo 内核权限失败'
"$STAGE/bin/mihomo" -v >/dev/null 2>&1 || die 'Mihomo 内核无法在此设备运行'

for NAME in env.sh firewall-start.sh firewall-stop.sh start.sh stop.sh status.sh boot-start.sh uninstall.sh; do
  cp "$D/scripts/$NAME" "$STAGE/scripts/$NAME" || die "复制 $NAME 失败"
  chmod 700 "$STAGE/scripts/$NAME" || die "设置 $NAME 权限失败"
done
cp "$D/ufi-backend.sh" "$STAGE/scripts/ufi-backend.sh" || die '复制 ufi-backend.sh 失败'
chmod 700 "$STAGE/scripts/ufi-backend.sh" || die '设置 ufi-backend.sh 权限失败'

if [ -n "$CONFIG_SOURCE" ]; then
  cp "$CONFIG_SOURCE" "$STAGE/config/config.yaml" || die '复制配置失败'
  CONFIG_READY=1
elif [ -n "$SUBSCRIPTION_FILE" ]; then
  render_template "$D/config/config.template.yaml" "$STAGE/config/config.yaml"
  CONFIG_READY=1
else
  cp "$D/config/config.template.yaml" "$STAGE/config/config.yaml" || die '复制待配置模板失败'
  touch "$STAGE/$PENDING_MARKER" || die '创建待配置标记失败'
  CONFIG_READY=0
fi
chmod 600 "$STAGE/config/config.yaml" 2>/dev/null || true

for DATA in GeoIP.dat GeoSite.dat country.mmdb geoip.metadb; do
  [ ! -f "$D/runtime/$DATA" ] || cp "$D/runtime/$DATA" "$STAGE/$DATA" || die "复制 $DATA 失败"
done
if [ -d "$D/runtime/ui" ]; then
  mkdir -p "$STAGE/ui" || die '无法创建 UI 目录'
  cp -R "$D/runtime/ui/." "$STAGE/ui/" || die '复制 MetaCubeXD 失败'
fi
if [ -d "$D/runtime/providers" ]; then
  cp -R "$D/runtime/providers/." "$STAGE/providers/" || die '复制初始 provider 缓存失败'
fi

if [ "$CONFIG_READY" -eq 1 ]; then
  "$STAGE/bin/mihomo" -t -d "$STAGE" -f "$STAGE/config/config.yaml" || die '配置校验失败；未修改正式安装目录'
fi

mv "$STAGE" "$BASE" || die '无法提交正式安装目录'
STAGE=''

if [ "$CONFIG_READY" -eq 0 ]; then
  say "OK: F50 Mihomo $VERSION 后端已安装，等待填写订阅链接。"
  say 'INFO: Mihomo 尚未启动，TProxy 和开机自启尚未启用。'
  exit 0
fi

if [ "$START_AFTER" -eq 1 ]; then
  if ! OUTPUT=$(sh "$BASE/scripts/ufi-backend.sh" start 2>&1); then
    say "$OUTPUT" >&2
    sh "$BASE/scripts/stop.sh" >/dev/null 2>&1 || true
    FAILED=/data/f50-mihomo.failed.$STAMP
    if mv "$BASE" "$FAILED" 2>/dev/null; then
      die "首次启动或双栈健康检查失败；失败现场保存在 $FAILED"
    fi
    die "首次启动或双栈健康检查失败；无法移动失败现场，请检查 $BASE"
  fi
  say "$OUTPUT"
fi

if [ "$ENABLE_BOOT" -eq 1 ]; then
  touch "$BOOT_FILE" || die '无法访问 UFI-Tools 开机脚本'
  if ! grep -Fq "$BOOT_MATCH" "$BOOT_FILE" 2>/dev/null; then
    printf '%s\n' "$BOOT_COMMAND" >> "$BOOT_FILE" || die '写入开机自启失败'
  fi
fi

say "OK: F50 Mihomo $VERSION 全新安装完成"
[ "$START_AFTER" -eq 1 ] || say 'INFO: 已按 --no-start 安装，当前没有启动 Mihomo。'
[ "$ENABLE_BOOT" -eq 1 ] || say 'INFO: 已按 --no-boot 跳过开机自启。'
