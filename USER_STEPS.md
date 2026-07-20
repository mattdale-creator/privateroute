# PrivateRoute — what you need to do

## Already done for you

- Full P0 product built and in GitHub: https://github.com/mattdale-creator/privateroute  
- Control plane running in Docker on this Mac  
- Public HTTPS tunnel to the dashboard (Cloudflare quick tunnel)  
- Background SSH poller waiting on Contabo `46.250.242.1` to auto-deploy  
- Demo account with active subscription  
- Auto-start LaunchAgent install script (optional one command)

## Perfect end state (real VPN)

Traffic exits your Contabo IP via WireGuard. That needs **one** of the following unlocks:

### Option A — Preferred (no paste if SSH heals)

Do nothing. The poller deploys automatically when SSH works.

### Option B — Contabo VNC (one paste)

1. Open Contabo control panel → your VPS → **VNC / console**  
2. Log in as root  
3. Paste:

```bash
curl -fsSL https://raw.githubusercontent.com/mattdale-creator/privateroute/main/scripts/contabo-console-one-shot.sh | bash
```

4. Open the URL it prints (`http://YOUR_IP:8787/`)

### Option C — Fresh cloud VPS (if you add a token)

```bash
export DIGITALOCEAN_TOKEN=...   # or other provider token
# then ask the agent to provision — no Contabo needed
```

## Use the product (any time)

1. Open local **http://127.0.0.1:8787/** or the current public tunnel URL in `.zero-touch/public-url.txt`  
2. Log in: `demo@privateroute.local` / `password123` (or sign up)  
3. **Add device** → download `.conf` or scan QR  
4. Import into the official **WireGuard** app  
5. Connect — **only works for real internet exit after Option A/B/C completes**

## Optional: survive Mac reboots

```bash
bash /Users/hattr/privateroute/scripts/install-autostart-macos.sh
```

## Check readiness

```bash
curl -s http://127.0.0.1:8787/api/status | python3 -m json.tool
```

`"vpnExitReady": true` means configs will route through a real public node.
