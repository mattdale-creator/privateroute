/**
 * PrivateRoute node agent — reconciles WireGuard peers from control plane.
 * Uses `wg` CLI (host must have WireGuard installed).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CONTROL_PLANE = process.env.CONTROL_PLANE_URL || "http://127.0.0.1:8787";
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
const WG_INTERFACE = process.env.WG_INTERFACE || "wg0";
const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 5000);
const DRY_RUN = process.env.DRY_RUN === "1";

if (!AGENT_TOKEN) {
  console.error("AGENT_TOKEN is required");
  process.exit(1);
}

type Peer = { publicKey: string; allowedIps: string };

async function fetchPeers(): Promise<Peer[]> {
  const res = await fetch(`${CONTROL_PLANE}/api/agent/peers`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`peers fetch failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { peers: Peer[] };
  return data.peers || [];
}

async function listLocalPeers(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync("wg", ["show", WG_INTERFACE, "peers"]);
    return new Set(
      stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function setPeer(publicKey: string, allowedIps: string) {
  if (DRY_RUN) {
    console.log(`[dry-run] set peer ${publicKey.slice(0, 8)}… ${allowedIps}`);
    return;
  }
  await execFileAsync("wg", [
    "set",
    WG_INTERFACE,
    "peer",
    publicKey,
    "allowed-ips",
    allowedIps,
  ]);
}

async function removePeer(publicKey: string) {
  if (DRY_RUN) {
    console.log(`[dry-run] remove peer ${publicKey.slice(0, 8)}…`);
    return;
  }
  await execFileAsync("wg", ["set", WG_INTERFACE, "peer", publicKey, "remove"]);
}

async function heartbeat() {
  try {
    await fetch(`${CONTROL_PLANE}/api/agent/heartbeat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        interface: WG_INTERFACE,
        ts: new Date().toISOString(),
        dryRun: DRY_RUN,
      }),
    });
  } catch (e) {
    console.warn("heartbeat failed", e);
  }
}

async function reconcile() {
  const desired = await fetchPeers();
  const desiredMap = new Map(desired.map((p) => [p.publicKey, p.allowedIps]));
  const local = await listLocalPeers();

  for (const [pub, allowed] of desiredMap) {
    if (!local.has(pub)) {
      console.log(`+ peer ${pub.slice(0, 12)}… ${allowed}`);
      await setPeer(pub, allowed);
    } else {
      // ensure allowed-ips stay correct
      await setPeer(pub, allowed);
    }
  }

  for (const pub of local) {
    if (!desiredMap.has(pub)) {
      console.log(`- peer ${pub.slice(0, 12)}…`);
      await removePeer(pub);
    }
  }

  await heartbeat();
}

async function loop() {
  console.log(
    `PrivateRoute agent → ${CONTROL_PLANE} iface=${WG_INTERFACE} dryRun=${DRY_RUN}`,
  );
  for (;;) {
    try {
      await reconcile();
    } catch (e) {
      console.error("reconcile error", e);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

loop();
