#!/system/bin/sh

set -u

D=$(dirname "$0")
. "$D/env.sh"

ipt() { iptables -w 15 "$@"; }
ip6t() { ip6tables -w 15 "$@"; }

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  "$D/firewall-stop.sh" >/dev/null 2>&1 || true
  exit 1
}

read_fake_ip6_range() {
  awk '
    /^[[:space:]]*fake-ip-range6[[:space:]]*:/ {
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

mkdir -p "$BASE/run" || fail "无法创建运行目录"
ip link show "$LAN_IF" >/dev/null 2>&1 || fail "LAN interface missing: $LAN_IF"
ip6tables -t mangle -S >/dev/null 2>&1 || fail "设备缺少 IPv6 mangle 表"
grep -qx 'TPROXY' /proc/net/ip6_tables_targets 2>/dev/null || fail "内核缺少 IPv6 TPROXY target"

FAKE_IP6_RANGE=$(read_fake_ip6_range)
case "$FAKE_IP6_RANGE" in
  *:*/*) ;;
  *) fail "配置缺少有效的 dns.fake-ip-range6" ;;
esac

LEGACY_TABLE_MARKER=$BASE/run/owns-route-table-$ROUTE_TABLE
EXISTING4=$(ip route show table "$ROUTE_TABLE" 2>/dev/null || true)
if [ -n "$EXISTING4" ] && [ ! -f "$TABLE_MARKER4" ] && [ ! -f "$LEGACY_TABLE_MARKER" ]; then
  printf 'ERROR: IPv4 route table %s is owned by another component:\n%s\n' "$ROUTE_TABLE" "$EXISTING4" >&2
  exit 1
fi

EXISTING6=$(ip -6 route show table "$ROUTE_TABLE" 2>/dev/null || true)
if [ -n "$EXISTING6" ] && [ ! -f "$TABLE_MARKER6" ]; then
  printf 'ERROR: IPv6 route table %s is owned by another component:\n%s\n' "$ROUTE_TABLE" "$EXISTING6" >&2
  exit 1
fi

# Start from a known state. The stop script removes both current and legacy
# IPv4 rules as well as any partially installed IPv6 rules.
"$D/firewall-stop.sh" >/dev/null 2>&1 || true

touch "$TABLE_MARKER4" || fail "无法记录 IPv4 路由表所有权"
ip route add local 0.0.0.0/0 dev lo table "$ROUTE_TABLE" || fail "无法创建 IPv4 本地路由"
ip rule add pref "$RULE_PREF" fwmark "$MARK/$MARK_MASK" lookup "$ROUTE_TABLE" || fail "无法创建 IPv4 策略路由"

touch "$TABLE_MARKER6" || fail "无法记录 IPv6 路由表所有权"
ip -6 route add local ::/0 dev lo table "$ROUTE_TABLE" || fail "无法创建 IPv6 本地路由"
ip -6 rule add pref "$RULE_PREF" fwmark "$MARK/$MARK_MASK" lookup "$ROUTE_TABLE" || fail "无法创建 IPv6 策略路由"

# IPv4: keep the proven DNS REDIRECT path because this kernel provides an IPv4
# nat table. TProxy handles all other TCP and UDP traffic from hotspot clients.
ipt -t mangle -N "$MANGLE_CHAIN4" || fail "无法创建 IPv4 mangle 链"
ipt -t mangle -A "$MANGLE_CHAIN4" -p udp --dport 53 -j RETURN || fail "无法添加 IPv4 DNS 旁路"
ipt -t mangle -A "$MANGLE_CHAIN4" -p tcp --dport 53 -j RETURN || fail "无法添加 IPv4 DNS 旁路"
for NET4 in 0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  ipt -t mangle -A "$MANGLE_CHAIN4" -d "$NET4" -j RETURN || fail "无法添加 IPv4 保留地址旁路"
done
ipt -t mangle -A "$MANGLE_CHAIN4" -p tcp -j TPROXY --on-port "$TPROXY_PORT" --tproxy-mark "$MARK/$MARK_MASK" || fail "无法添加 IPv4 TCP TProxy"
ipt -t mangle -A "$MANGLE_CHAIN4" -p udp -j TPROXY --on-port "$TPROXY_PORT" --tproxy-mark "$MARK/$MARK_MASK" || fail "无法添加 IPv4 UDP TProxy"
ipt -t mangle -I PREROUTING 1 -i "$LAN_IF" -s "$LAN_NET4" -j "$MANGLE_CHAIN4" || fail "无法挂载 IPv4 TProxy"

ipt -t nat -N "$DNS_CHAIN4" || fail "无法创建 IPv4 DNS 链"
ipt -t nat -A "$DNS_CHAIN4" -p udp -j REDIRECT --to-ports "$DNS_PORT" || fail "无法添加 IPv4 UDP DNS 重定向"
ipt -t nat -A "$DNS_CHAIN4" -p tcp -j REDIRECT --to-ports "$DNS_PORT" || fail "无法添加 IPv4 TCP DNS 重定向"
ipt -t nat -I PREROUTING 1 -i "$LAN_IF" -s "$LAN_NET4" -p udp --dport 53 -j "$DNS_CHAIN4" || fail "无法挂载 IPv4 UDP DNS"
ipt -t nat -I PREROUTING 1 -i "$LAN_IF" -s "$LAN_NET4" -p tcp --dport 53 -j "$DNS_CHAIN4" || fail "无法挂载 IPv4 TCP DNS"

# IPv6: this F50 kernel has TPROXY but no ip6tables nat table. Capture public
# TCP/UDP (including public DNS) with TProxy. Preserve link-local, multicast,
# ULA and the current on-link LAN prefixes. The configured fake-IP range is
# deliberately captured before the ULA bypass because Mihomo's default
# fake-ip-range6 is itself ULA.
ip6t -t mangle -N "$MANGLE_CHAIN6" || fail "无法创建 IPv6 mangle 链"
ip6t -t mangle -A "$MANGLE_CHAIN6" -d "$FAKE_IP6_RANGE" -p tcp -j TPROXY --on-port "$TPROXY_PORT" --tproxy-mark "$MARK/$MARK_MASK" || fail "无法添加 IPv6 fake-IP TCP TProxy"
ip6t -t mangle -A "$MANGLE_CHAIN6" -d "$FAKE_IP6_RANGE" -p udp -j TPROXY --on-port "$TPROXY_PORT" --tproxy-mark "$MARK/$MARK_MASK" || fail "无法添加 IPv6 fake-IP UDP TProxy"

# Route output contains the normalized network prefix (not a host address with
# prefix length), avoiding host/network mismatch errors from ip6tables.
for LAN_PREFIX6 in $(ip -6 route show dev "$LAN_IF" scope link 2>/dev/null | awk '$1 ~ /:/ && $1 ~ /\// {print $1}'); do
  ip6t -t mangle -A "$MANGLE_CHAIN6" -d "$LAN_PREFIX6" -j RETURN || fail "无法添加 IPv6 LAN 前缀旁路"
done

for NET6 in ::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 100::/64 2001:db8::/32 fe80::/10 fc00::/7 ff00::/8; do
  ip6t -t mangle -A "$MANGLE_CHAIN6" -d "$NET6" -j RETURN || fail "无法添加 IPv6 保留地址旁路"
done

ip6t -t mangle -A "$MANGLE_CHAIN6" -p tcp -j TPROXY --on-port "$TPROXY_PORT" --tproxy-mark "$MARK/$MARK_MASK" || fail "无法添加 IPv6 TCP TProxy"
ip6t -t mangle -A "$MANGLE_CHAIN6" -p udp -j TPROXY --on-port "$TPROXY_PORT" --tproxy-mark "$MARK/$MARK_MASK" || fail "无法添加 IPv6 UDP TProxy"
ip6t -t mangle -I PREROUTING 1 -i "$LAN_IF" -j "$MANGLE_CHAIN6" || fail "无法挂载 IPv6 TProxy"

echo "IPv4 and IPv6 TProxy enabled. fake-ip-range6=$FAKE_IP6_RANGE"
