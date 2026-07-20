#!/usr/bin/env bash
# Zero-touch PrivateRoute P0:
#  1) Ensures Docker control plane is up
#  2) Opens a free public HTTPS URL (cloudflared quick tunnel, no account)
#  3) Background-polls Contabo SSH and auto-deploys when it answers
#
# You should not need to interact after starting this.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOST="${PR_VPS_HOST:-46.250.242.1}"
SSH_USER="${PR_VPS_USER:-root}"
SSH_KEY="${PR_VPS_KEY:-$HOME/.ssh/vps_contabo}"
SSH_KEY2="${PR_VPS_KEY2:-$HOME/.ssh/vps_contabo_secure}"
POLL_SECS="${PR_POLL_SECS:-60}"
STATE_DIR="${ROOT}/.zero-touch"
mkdir -p "$STATE_DIR"

log() { echo "[$(date -Iseconds)] $*"; }

ensure_compose() {
  if ! curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then
    log "Starting local Docker control plane..."
    (cd "$ROOT/deploy/compose" && docker compose up -d --build)
    for i in $(seq 1 40); do
      curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break
      sleep 2
    done
  fi
  curl -fsS http://127.0.0.1:8787/health >/dev/null
  log "Control plane healthy on :8787"
}

ensure_node_registered() {
  local nodes
  nodes=$(curl -fsS http://127.0.0.1:8787/api/nodes | python3 -c 'import sys,json;print(json.load(sys.stdin).get("nodes") and len(json.load(open("/dev/stdin"))) if False else len(json.load(sys.stdin).get("nodes",[])))' 2>/dev/null || echo 0)
  # simpler:
  nodes=$(curl -fsS http://127.0.0.1:8787/api/nodes | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("nodes",[])))')
  if [[ "$nodes" -gt 0 ]]; then
    log "Nodes already registered: $nodes"
    return
  fi
  log "Registering placeholder local node (until VPS deploys)"
  local pub
  pub=$(python3 -c 'import base64,os;print(base64.b64encode(os.urandom(32)).decode())')
  curl -fsS -X POST http://127.0.0.1:8787/api/admin/bootstrap-node \
    -H 'Content-Type: application/json' \
    -H 'x-bootstrap-token: bootstrap-dev-token' \
    -d "{\"name\":\"local-pending-vps\",\"region\":\"pending\",\"publicIp\":\"127.0.0.1\",\"wgPublicKey\":\"$pub\",\"wgListenPort\":51820}" \
    >"$STATE_DIR/bootstrap-local.json"
}

start_public_tunnel() {
  if [[ -f "$STATE_DIR/public-url.txt" ]] && kill -0 "$(cat "$STATE_DIR/cloudflared.pid" 2>/dev/null)" 2>/dev/null; then
    log "Tunnel already up: $(cat "$STATE_DIR/public-url.txt")"
    return
  fi

  if ! command -v cloudflared >/dev/null 2>&1; then
    log "cloudflared missing — trying brew install"
    brew install cloudflare/cloudflare/cloudflared >/dev/null 2>&1 || true
  fi

  if command -v cloudflared >/dev/null 2>&1; then
    log "Starting cloudflared quick tunnel (no account)..."
    rm -f "$STATE_DIR/cloudflared.log"
    nohup cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate \
      >"$STATE_DIR/cloudflared.log" 2>&1 &
    echo $! >"$STATE_DIR/cloudflared.pid"
    for i in $(seq 1 30); do
      if grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$STATE_DIR/cloudflared.log" | head -1 >"$STATE_DIR/public-url.txt"; then
        if [[ -s "$STATE_DIR/public-url.txt" ]]; then
          log "PUBLIC DASHBOARD: $(cat "$STATE_DIR/public-url.txt")"
          return
        fi
      fi
      sleep 1
    done
    log "cloudflared started but URL not parsed yet — see $STATE_DIR/cloudflared.log"
    return
  fi

  # Fallback: localtunnel via npx (ephemeral)
  log "Falling back to localtunnel..."
  nohup npx --yes localtunnel --port 8787 >"$STATE_DIR/localtunnel.log" 2>&1 &
  echo $! >"$STATE_DIR/localtunnel.pid"
  for i in $(seq 1 40); do
    if grep -oE 'https://[a-zA-Z0-9.-]+\.loca\.lt' "$STATE_DIR/localtunnel.log" | head -1 >"$STATE_DIR/public-url.txt"; then
      if [[ -s "$STATE_DIR/public-url.txt" ]]; then
        log "PUBLIC DASHBOARD: $(cat "$STATE_DIR/public-url.txt")"
        return
      fi
    fi
    sleep 1
  done
  log "No public tunnel available; use http://127.0.0.1:8787"
}

ssh_ok() {
  local key="$1" user="$2" host="$3" port="${4:-22}"
  [[ -f "$key" ]] || return 1
  ssh -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 \
    -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes \
    -i "$key" -p "$port" "${user}@${host}" 'echo PR_SSH_OK' 2>/dev/null | grep -q PR_SSH_OK
}

try_deploy_vps() {
  if [[ -f "$STATE_DIR/vps-deployed.ok" ]]; then
    return 0
  fi
  local key user
  for key in "$SSH_KEY" "$SSH_KEY2"; do
    for user in root secure ubuntu admin; do
      for port in 22 2222; do
        if ssh_ok "$key" "$user" "$HOST" "$port"; then
          log "SSH WORKS: $user@$HOST:$port with $key — deploying"
          export HOST="${user}@${HOST}" KEY="$key"
          # fix port if needed
          if [[ "$port" != "22" ]]; then
            rsync -az -e "ssh -i $key -p $port -o StrictHostKeyChecking=accept-new" \
              --exclude node_modules --exclude .git --exclude .zero-touch \
              "$ROOT/" "${user}@${HOST}:/opt/privateroute/"
            ssh -i "$key" -p "$port" -o StrictHostKeyChecking=accept-new "${user}@${HOST}" \
              'sudo bash /opt/privateroute/scripts/deploy-vps.sh' \
              | tee "$STATE_DIR/vps-deploy.log"
          else
            HOST="${user}@${HOST}" KEY="$key" bash "$ROOT/scripts/remote-install.sh" \
              | tee "$STATE_DIR/vps-deploy.log"
          fi
          date -Iseconds >"$STATE_DIR/vps-deployed.ok"
          log "VPS deploy finished"
          return 0
        fi
      done
    done
  done
  return 1
}

poll_vps_loop() {
  log "Polling $HOST for SSH every ${POLL_SECS}s (zero human input)..."
  while true; do
    if try_deploy_vps; then
      log "VPS online and deployed. Poller sleeping (will not re-deploy)."
      # keep process alive for tunnel
      while true; do sleep 3600; done
    fi
    sleep "$POLL_SECS"
  done
}

main() {
  ensure_compose
  ensure_node_registered
  start_public_tunnel
  echo ""
  echo "=============================================="
  echo " PrivateRoute zero-touch"
  echo " Local:  http://127.0.0.1:8787/"
  if [[ -f "$STATE_DIR/public-url.txt" ]]; then
    echo " Public: $(cat "$STATE_DIR/public-url.txt")"
  fi
  echo " VPS poll: $HOST (auto-deploy when SSH works)"
  echo " State: $STATE_DIR"
  echo "=============================================="
  echo ""
  # Run poller in foreground so this is one long-lived process
  poll_vps_loop
}

main "$@"
