# Zero-touch operation model

## Goal

Run PrivateRoute with **no interactive steps** from you after a single background process is started.

## What runs automatically now

| Component | How | Needs you? |
|-----------|-----|------------|
| Control plane (API + dashboard) | Docker Compose on this Mac | No (already up) |
| Public HTTPS URL | Cloudflare **quick tunnel** (no account) | No |
| VPS deploy | SSH poller every 60s → `remote-install.sh` | No, once SSH works |
| Subscriptions | `AUTO_ACTIVATE_SUBSCRIPTION=1` | No Stripe keys |
| Device configs | Server-side WireGuard keygen | No |

## Start / resume zero-touch

```bash
# One command — keeps tunnel + poller logic (or use pieces below)
bash /Users/hattr/privateroute/scripts/zero-touch.sh
```

Currently active on this machine (session):

- Local: http://127.0.0.1:8787/
- Public: see `.zero-touch/public-url.txt`
- Poller: `.zero-touch/poller.pid` watching `46.250.242.1`

## Hard limit (physics + access)

A **real commercial VPN exit** needs a machine with:

1. A public IP  
2. Ability to run WireGuard + NAT  
3. **Admin access we can reach** (SSH or equivalent)

Your Contabo `46.250.242.1`:

- HTTP works (Apache voucher app)  
- SSH **banner times out** from this network  
- Tailscale IP for Contabo not online  
- No cloud API tokens to create a *new* VPS  

So auto-deploy **will** complete the moment SSH answers — poller is waiting.  
It **cannot** invent admin access if none exists.

## Rethink: better than “paste in console”

| Approach | Zero human? | Real VPN exit? |
|----------|-------------|----------------|
| Contabo console paste | One paste | Yes |
| SSH poller (running) | Yes after SSH heals | Yes |
| Cloud API provision | Yes if API token present | Yes |
| Cloudflare tunnel | Yes | **No** (dashboard only, not WG UDP) |
| Mac as Tailscale exit node | Needs `sudo tailscale` once | Home ISP exit, not Contabo |

## If you add one secret later (optional)

Put a cloud token in env and we can provision a fresh VPS without Contabo:

```bash
export DIGITALOCEAN_TOKEN=...   # or HCLOUD_TOKEN, etc.
# then a provision script can create droplet + deploy
```

Without that, the poller + public tunnel is the maximum zero-input path.
