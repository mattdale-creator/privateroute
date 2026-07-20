#!/usr/bin/env bash
# Full P0 deploy on a Linux VPS: Docker control plane + WireGuard + agent.
# Usage: sudo bash scripts/deploy-vps.sh
# Or remote: ssh root@HOST 'bash -s' < scripts/deploy-vps.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/privateroute}"
REPO_URL="${REPO_URL:-}"
BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN:-$(openssl rand -hex 16)}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
PUBLIC_IP="${PUBLIC_IP:-}"

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing Docker if needed"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

echo "==> Preparing app dir ${APP_DIR}"
mkdir -p "$APP_DIR"
# If script is run from repo checkout, copy; else expect files already present
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
if [[ -f "${ROOT_DIR}/package.json" ]]; then
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude apps/api/dist \
    "${ROOT_DIR}/" "${APP_DIR}/"
fi

cd "$APP_DIR"

echo "==> Bootstrap WireGuard"
bash "${APP_DIR}/scripts/bootstrap-wireguard.sh" | tee /tmp/pr-wg.env
# shellcheck disable=SC1091
source /tmp/pr-wg.env
PUBLIC_IP="${PUBLIC_IP:-$WG_PUBLIC_IP}"

echo "==> Start control plane"
export JWT_SECRET BOOTSTRAP_TOKEN
export PUBLIC_URL="http://${PUBLIC_IP}:8787"
export COOKIE_SECURE=0
cd "${APP_DIR}/deploy/compose"
docker compose up -d --build

echo "==> Wait for API"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:8787/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS "http://127.0.0.1:8787/health"

echo "==> Register node with control plane"
REG=$(curl -fsS -X POST "http://127.0.0.1:8787/api/admin/bootstrap-node" \
  -H "Content-Type: application/json" \
  -H "x-bootstrap-token: ${BOOTSTRAP_TOKEN}" \
  -d "{\"name\":\"primary\",\"region\":\"auto\",\"publicIp\":\"${PUBLIC_IP}\",\"wgPublicKey\":\"${WG_PUBLIC_KEY}\",\"wgListenPort\":${WG_PORT},\"wgSubnetCidr\":\"${WG_SUBNET}\"}")
echo "$REG"
AGENT_TOKEN=$(echo "$REG" | jq -r .agentToken)

echo "==> Install node agent systemd unit"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
cd "${APP_DIR}/apps/node-agent"
npm install --omit=dev
npx tsc -p tsconfig.json || npx tsx --version >/dev/null

cat > /etc/systemd/system/privateroute-agent.service <<EOF
[Unit]
Description=PrivateRoute WireGuard node agent
After=network.target docker.service

[Service]
Type=simple
Environment=CONTROL_PLANE_URL=http://127.0.0.1:8787
Environment=AGENT_TOKEN=${AGENT_TOKEN}
Environment=WG_INTERFACE=wg0
Environment=RECONCILE_INTERVAL_MS=5000
WorkingDirectory=${APP_DIR}/apps/node-agent
ExecStart=/usr/bin/node ${APP_DIR}/apps/node-agent/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# Prefer compiled; fall back to tsx
if [[ ! -f ${APP_DIR}/apps/node-agent/dist/index.js ]]; then
  cd "${APP_DIR}/apps/node-agent" && npm install && npx tsc -p tsconfig.json
fi

systemctl daemon-reload
systemctl enable --now privateroute-agent.service

# Open firewall if ufw present
if command -v ufw >/dev/null 2>&1; then
  ufw allow 51820/udp || true
  ufw allow 8787/tcp || true
fi

# Save secrets
cat > /root/privateroute-p0.env <<EOF
PUBLIC_URL=http://${PUBLIC_IP}:8787
BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}
JWT_SECRET=${JWT_SECRET}
AGENT_TOKEN=${AGENT_TOKEN}
WG_PUBLIC_KEY=${WG_PUBLIC_KEY}
WG_PUBLIC_IP=${PUBLIC_IP}
EOF
chmod 600 /root/privateroute-p0.env

echo ""
echo "============================================"
echo "PrivateRoute P0 is up"
echo "Dashboard: http://${PUBLIC_IP}:8787/"
echo "Health:    http://${PUBLIC_IP}:8787/health"
echo "Secrets:   /root/privateroute-p0.env"
echo "============================================"
