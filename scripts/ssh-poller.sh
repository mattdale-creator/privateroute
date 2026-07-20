#!/usr/bin/env bash
# Background: when Contabo SSH works, deploy automatically. No human input.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOST_IP="${PR_VPS_HOST:-46.250.242.1}"
STATE="$ROOT/.zero-touch"
mkdir -p "$STATE"

while true; do
  if [[ -f "$STATE/vps-deployed.ok" ]]; then
    sleep 3600
    continue
  fi
  for key in "$HOME/.ssh/vps_contabo" "$HOME/.ssh/vps_contabo_secure"; do
    [[ -f "$key" ]] || continue
    for user in root secure ubuntu; do
      if ssh -o BatchMode=yes -o ConnectTimeout=6 -o ConnectionAttempts=1 \
        -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes \
        -i "$key" "${user}@${HOST_IP}" 'echo OK' 2>/dev/null | grep -q OK; then
        echo "[$(date -Iseconds)] SSH up ${user}@${HOST_IP} via $key"
        HOST="${user}@${HOST_IP}" KEY="$key" bash "$ROOT/scripts/remote-install.sh" \
          >>"$STATE/vps-deploy.log" 2>&1 && date -Iseconds >"$STATE/vps-deployed.ok"
      fi
    done
  done
  echo "[$(date -Iseconds)] poll miss ${HOST_IP}"
  sleep 60
done
