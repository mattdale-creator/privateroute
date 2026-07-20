# VPS deploy status (2026-07-20)

## Target host

| Field | Value |
|-------|--------|
| Provider | Contabo |
| Public IP | `46.250.242.1` |
| Tailscale IP (historical) | `100.102.150.27` |
| SSH keys on Mac | `~/.ssh/vps_contabo`, `~/.ssh/vps_contabo_secure` |

## What we verified

- Host **responds to ping**
- TCP ports **22, 80, 443, 51820, … appear open** to `nc`
- **SSH banner exchange times out** from this machine (root/secure, ports 22/2222)
- Tailscale on the Mac is **stopped**; mesh path unavailable
- No cloud API tokens found for auto-provisioning a *new* VPS (`doctl`/`hcloud`/`aws` absent)

## Conclusion

P0 software is complete and running **locally in Docker**.  
Remote Contabo deploy is blocked until SSH (or Contabo VNC console) works again.

## Unblock Contabo (one of)

1. **Contabo VNC console** → login as root → paste:

```bash
curl -fsSL https://raw.githubusercontent.com/mattdale-creator/privateroute/main/scripts/contabo-console-one-shot.sh | bash
```

2. Or from console, fix SSH then from Mac:

```bash
HOST=root@46.250.242.1 KEY=~/.ssh/vps_contabo ./scripts/remote-install.sh
```

3. Or start Tailscale on the VPS + Mac, then:

```bash
HOST=secure@100.102.150.27 KEY=~/.ssh/vps_contabo_secure ./scripts/remote-install.sh
```
