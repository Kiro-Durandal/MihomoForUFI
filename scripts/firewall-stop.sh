#!/system/bin/sh

set -u

D=$(dirname "$0")
. "$D/env.sh"

ipt() { iptables -w 15 "$@"; }
ip6t() { ip6tables -w 15 "$@"; }

LEGACY_TABLE_MARKER=$BASE/run/owns-route-table-$ROUTE_TABLE

# Remove only jumps owned by this package. Loops also clean duplicates left by
# interrupted older starts.
while ipt -t mangle -D PREROUTING -i "$LAN_IF" -s "$LAN_NET4" -j "$MANGLE_CHAIN4" 2>/dev/null; do :; done
while ipt -t nat -D PREROUTING -i "$LAN_IF" -s "$LAN_NET4" -p udp --dport 53 -j "$DNS_CHAIN4" 2>/dev/null; do :; done
while ipt -t nat -D PREROUTING -i "$LAN_IF" -s "$LAN_NET4" -p tcp --dport 53 -j "$DNS_CHAIN4" 2>/dev/null; do :; done
while ip6t -t mangle -D PREROUTING -i "$LAN_IF" -j "$MANGLE_CHAIN6" 2>/dev/null; do :; done

ipt -t mangle -F "$MANGLE_CHAIN4" 2>/dev/null || true
ipt -t mangle -X "$MANGLE_CHAIN4" 2>/dev/null || true
ipt -t nat -F "$DNS_CHAIN4" 2>/dev/null || true
ipt -t nat -X "$DNS_CHAIN4" 2>/dev/null || true
ip6t -t mangle -F "$MANGLE_CHAIN6" 2>/dev/null || true
ip6t -t mangle -X "$MANGLE_CHAIN6" 2>/dev/null || true

# Delete only rules matching this package's mark and table. Never delete an
# unrelated Android rule merely because it shares a preference number.
while ip rule del pref "$RULE_PREF" fwmark "$MARK/$MARK_MASK" lookup "$ROUTE_TABLE" 2>/dev/null; do :; done
while ip -6 rule del pref "$RULE_PREF" fwmark "$MARK/$MARK_MASK" lookup "$ROUTE_TABLE" 2>/dev/null; do :; done

if [ -f "$TABLE_MARKER4" ] || [ -f "$LEGACY_TABLE_MARKER" ]; then
  ip route flush table "$ROUTE_TABLE" 2>/dev/null || true
  rm -f "$TABLE_MARKER4" "$LEGACY_TABLE_MARKER"
fi

if [ -f "$TABLE_MARKER6" ]; then
  ip -6 route flush table "$ROUTE_TABLE" 2>/dev/null || true
  rm -f "$TABLE_MARKER6"
fi

echo "IPv4 and IPv6 TProxy rules removed."
