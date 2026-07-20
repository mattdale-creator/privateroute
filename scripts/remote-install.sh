#!/usr/bin/env bash
# Push repo to a host and run deploy-vps.sh
# Usage: HOST=root@1.2.3.4 KEY=~/.ssh/key ./scripts/remote-install.sh
set -euo pipefail
HOST="${HOST:?set HOST=user@ip}"
KEY="${KEY:-}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
if [[ -n "$KEY" ]]; then SSH_OPTS+=(-i "$KEY"); fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
echo "Syncing to ${HOST}:/opt/privateroute ..."
ssh "${SSH_OPTS[@]}" "$HOST" 'mkdir -p /opt/privateroute'
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules --exclude .git --exclude '**/dist' \
  "$ROOT/" "${HOST}:/opt/privateroute/"

ssh "${SSH_OPTS[@]}" "$HOST" 'bash /opt/privateroute/scripts/deploy-vps.sh'
echo "Done."
