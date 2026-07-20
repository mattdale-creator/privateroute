# PrivateRoute (P0)

Commercial WireGuard VPN **spine**: control plane + dashboard + node agent.

```text
Signup → auto subscription (P0) → create device → WireGuard config/QR → agent provisions peer
```

## Quick start (local Docker)

```bash
cd deploy/compose
docker compose up -d --build
open http://localhost:8787
```

## VPS deploy

On a fresh Ubuntu/Debian host as root:

```bash
# from this repo on the server
sudo bash scripts/deploy-vps.sh
```

From your laptop:

```bash
HOST=root@YOUR_IP KEY=~/.ssh/your_key ./scripts/remote-install.sh
```

## Stack

| Piece | Tech |
|-------|------|
| API | Hono + Postgres |
| Web | Static dashboard |
| VPN | Kernel WireGuard |
| Agent | Reconciles peers via `wg set` |
| Billing | Auto-activate P0; Stripe hooks stubbed |

## Env

| Variable | Default |
|----------|---------|
| `AUTO_ACTIVATE_SUBSCRIPTION` | `1` |
| `BOOTSTRAP_TOKEN` | `bootstrap-dev-token` |
| `JWT_SECRET` | dev default |
| `DATABASE_URL` | local compose |

## Security notes

- P0 stores device private keys for re-download — rotate devices for higher assurance.
- Put TLS (Caddy) in front before production money.
- Open UDP **51820** and TCP **8787** (or reverse-proxy 443 only).
