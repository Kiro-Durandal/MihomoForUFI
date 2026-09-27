#!/system/bin/sh

# Restore the exact scripts saved by the most recent 2.6 upgrade. The live
# config is never touched by upgrade or rollback.

set -u

BASE=/data/f50-mihomo
SCRIPTS=$BASE/scripts
LAST_BACKUP=$BASE/run/last-v26-upgrade-backup
INSTALL_LOCK=$BASE/run/install-v26.lock
FILES='env.sh firewall-start.sh firewall-stop.sh start.sh stop.sh status.sh boot-start.sh uninstall.sh ufi-backend.sh'

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
release_lock() {
  rm -f "$INSTALL_LOCK/pid" 2>/dev/null || true
  rmdir "$INSTALL_LOCK" 2>/dev/null || true
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

[ "$(id -u 2>/dev/null)" = '0' ] || die '请在 Root 环境执行'
[ -f "$LAST_BACKUP" ] || die '没有找到 2.6 升级回退点记录'
acquire_lock
trap release_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

BACKUP_DIR=$(head -n 1 "$LAST_BACKUP" 2>/dev/null || true)
case "$BACKUP_DIR" in
  "$BASE"/backups/upgrade-v26-*) ;;
  *) die '回退点路径无效' ;;
esac
[ -d "$BACKUP_DIR" ] || die "回退目录不存在：$BACKUP_DIR"
[ ! -L "$BACKUP_DIR" ] || die '拒绝使用符号链接回退目录'

for NAME in $FILES; do
  if [ -f "$BACKUP_DIR/$NAME" ]; then
    sh -n "$BACKUP_DIR/$NAME" || die "回退点中的 $NAME 语法无效"
  elif [ ! -f "$BACKUP_DIR/.missing-$NAME" ]; then
    die "回退点缺少 $NAME 及其缺失标记"
  fi
done

# Use the new stop script first so both address families are cleaned before the
# old IPv4-only scripts are restored.
sh "$SCRIPTS/stop.sh" >/dev/null 2>&1 || true

for NAME in $FILES; do
  if [ -f "$BACKUP_DIR/$NAME" ]; then
    TEMP=$SCRIPTS/.$NAME.rollback.$$
    cp "$BACKUP_DIR/$NAME" "$TEMP" || die "复制 $NAME 失败"
    chmod 700 "$TEMP" 2>/dev/null || true
    mv "$TEMP" "$SCRIPTS/$NAME" || die "恢复 $NAME 失败"
  else
    rm -f "$SCRIPTS/$NAME" || die "删除升级新增文件 $NAME 失败"
  fi
done

if sh "$SCRIPTS/start.sh"; then
  printf '已恢复升级前脚本并重新启动 Mihomo；config.yaml 始终未修改。备份仍保留在：%s\n' "$BACKUP_DIR"
else
  die "脚本已恢复，但 Mihomo 启动失败。备份位于 $BACKUP_DIR"
fi
