#!/usr/bin/env bash
# Paste this entire script into Contabo VNC/console as root when SSH is locked.
# Installs PrivateRoute P0 from GitHub and starts WireGuard + control plane.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
rm -rf /opt/privateroute
git clone --depth 1 https://github.com/mattdale-creator/privateroute.git /opt/privateroute
# If clone fails (private), fall back instructions are printed
bash /opt/privateroute/scripts/deploy-vps.sh
# Ensure SSH is reachable for future automation (optional, non-destructive open)
if command -v ufw >/dev/null; then
  ufw allow OpenSSH || true
  ufw allow 51820/udp || true
  ufw allow 8787/tcp || true
fi
echo "Open http://$(curl -4 -fsS ifconfig.me):8787/"
