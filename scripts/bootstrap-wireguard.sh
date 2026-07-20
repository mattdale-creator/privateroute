#!/usr/bin/env bash
# Bootstrap WireGuard interface on a Linux VPS (run as root).
set -euo pipefail

WG_IF="${WG_IF:-wg0}"
WG_PORT="${WG_PORT:-51820}"
WG_SUBNET="${WG_SUBNET:-10.64.0.0/16}"
WG_ADDR="${WG_ADDR:-10.64.0.1/16}"
WG_DIR="${WG_DIR:-/etc/wireguard}"

export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq wireguard wireguard-tools iptables curl jq ca-certificates
fi

mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"

if [[ ! -f "$WG_DIR/${WG_IF}.key" ]]; then
  umask 077
  wg genkey | tee "$WG_DIR/${WG_IF}.key" | wg pubkey > "$WG_DIR/${WG_IF}.pub"
fi

PRIV=$(cat "$WG_DIR/${WG_IF}.key")
PUB=$(cat "$WG_DIR/${WG_IF}.pub")

# Detect default egress interface
WAN_IF=$(ip route show default | awk '/default/ {print $5; exit}')
if [[ -z "${WAN_IF:-}" ]]; then
  WAN_IF=eth0
fi

cat > "$WG_DIR/${WG_IF}.conf" <<EOF
[Interface]
Address = ${WG_ADDR}
ListenPort = ${WG_PORT}
PrivateKey = ${PRIV}
SaveConfig = false
PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -t nat -C POSTROUTING -s ${WG_SUBNET} -o ${WAN_IF} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${WG_SUBNET} -o ${WAN_IF} -j MASQUERADE; iptables -C FORWARD -i ${WG_IF} -j ACCEPT 2>/dev/null || iptables -A FORWARD -i ${WG_IF} -j ACCEPT; iptables -C FORWARD -o ${WG_IF} -j ACCEPT 2>/dev/null || iptables -A FORWARD -o ${WG_IF} -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -s ${WG_SUBNET} -o ${WAN_IF} -j MASQUERADE 2>/dev/null || true; iptables -D FORWARD -i ${WG_IF} -j ACCEPT 2>/dev/null || true; iptables -D FORWARD -o ${WG_IF} -j ACCEPT 2>/dev/null || true
EOF

chmod 600 "$WG_DIR/${WG_IF}.conf"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
# Persist ip_forward
if ! grep -q 'net.ipv4.ip_forward=1' /etc/sysctl.d/99-privateroute.conf 2>/dev/null; then
  echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-privateroute.conf
fi

wg-quick down "$WG_IF" 2>/dev/null || true
wg-quick up "$WG_IF"
systemctl enable "wg-quick@${WG_IF}" 2>/dev/null || true

PUBLIC_IP=$(curl -4 -fsS ifconfig.me || curl -4 -fsS icanhazip.com || hostname -I | awk '{print $1}')

echo "WG_PUBLIC_KEY=${PUB}"
echo "WG_PUBLIC_IP=${PUBLIC_IP}"
echo "WG_PORT=${WG_PORT}"
echo "WG_SUBNET=${WG_SUBNET}"
