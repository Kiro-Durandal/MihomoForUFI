#!/system/bin/sh

# Shared Mihomo runtime settings.
BASE=/data/f50-mihomo
BIN=$BASE/bin/mihomo
CFG=$BASE/config/config.yaml
LOG=$BASE/logs/mihomo.log
PIDFILE=$BASE/run/mihomo.pid

LAN_IF=br0
LAN_NET4=192.168.0.0/24
TPROXY_PORT=7894
DNS_PORT=1053

MARK=0x40000000
MARK_MASK=0x40000000
ROUTE_TABLE=2022
RULE_PREF=9000

MANGLE_CHAIN4=F50_MIHOMO
DNS_CHAIN4=F50_MIHOMO_DNS
MANGLE_CHAIN6=F50_MIHOMO6

TABLE_MARKER4=$BASE/run/owns-route-table4-$ROUTE_TABLE
TABLE_MARKER6=$BASE/run/owns-route-table6-$ROUTE_TABLE

# Keep compatibility with older helper scripts that source env.sh.
LAN_NET=$LAN_NET4
MANGLE_CHAIN=$MANGLE_CHAIN4
DNS_CHAIN=$DNS_CHAIN4
TABLE_MARKER=$TABLE_MARKER4

# The active log is trimmed only while Mihomo is stopped, before a new start.
LOG_MAX_BYTES=8388608
LOG_KEEP_BYTES=2097152
BOOT_LOG_MAX_BYTES=1048576
BOOT_LOG_KEEP_BYTES=262144
