import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import QRCode from "qrcode";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "./db.js";
import {
  authMiddleware,
  clearSessionCookie,
  hashPassword,
  setSessionCookie,
  signToken,
  verifyPassword,
  type Authed,
} from "./auth.js";
import { buildClientConfig, generateWireGuardKeypair, nextIpv4 } from "./wg.js";

type Vars = { user: Authed };

const app = new Hono<{ Variables: Vars }>();

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const DNS = process.env.WG_DNS || "1.1.1.1";
const AUTO_ACTIVATE = process.env.AUTO_ACTIVATE_SUBSCRIPTION !== "0";
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN || "bootstrap-dev-token";

app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
  }),
);

app.get("/health", (c) => c.json({ ok: true, service: "privateroute-api" }));

app.get("/api/meta", async (c) => {
  const nodes = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM nodes WHERE status = 'active'`,
  );
  return c.json({
    name: "PrivateRoute",
    publicUrl: PUBLIC_URL,
    autoActivate: AUTO_ACTIVATE,
    nodes: Number(nodes.rows[0]?.count || 0),
  });
});

// ---- Auth ----
const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

app.post("/api/auth/register", async (c) => {
  const body = credsSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const email = body.data.email.toLowerCase().trim();
  const existing = await query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing.rowCount) return c.json({ error: "email already registered" }, 409);

  const password_hash = await hashPassword(body.data.password);
  const user = await query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
    [email, password_hash],
  );
  const u = user.rows[0];

  // P0: auto-activate subscription (no Stripe required)
  if (AUTO_ACTIVATE) {
    await query(
      `INSERT INTO subscriptions (user_id, plan, status, device_limit)
       VALUES ($1, 'solo', 'active', 5)
       ON CONFLICT (user_id) DO UPDATE SET status = 'active'`,
      [u.id],
    );
  }

  const token = await signToken(u.id, u.email);
  setSessionCookie(c, token);
  return c.json({ token, user: { id: u.id, email: u.email } }, 201);
});

app.post("/api/auth/login", async (c) => {
  const body = credsSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid credentials" }, 400);
  const email = body.data.email.toLowerCase().trim();
  const res = await query<{ id: string; email: string; password_hash: string }>(
    `SELECT id, email, password_hash FROM users WHERE email = $1`,
    [email],
  );
  const u = res.rows[0];
  if (!u || !(await verifyPassword(body.data.password, u.password_hash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  const token = await signToken(u.id, u.email);
  setSessionCookie(c, token);
  return c.json({ token, user: { id: u.id, email: u.email } });
});

app.post("/api/auth/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/me", authMiddleware, async (c) => {
  const user = c.get("user");
  const sub = await query(
    `SELECT plan, status, device_limit, current_period_end FROM subscriptions WHERE user_id = $1`,
    [user.userId],
  );
  const devices = await query(
    `SELECT count(*)::int AS n FROM devices WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.userId],
  );
  return c.json({
    id: user.userId,
    email: user.email,
    subscription: sub.rows[0] || { plan: "none", status: "inactive", device_limit: 0 },
    deviceCount: devices.rows[0]?.n ?? 0,
  });
});

// ---- Nodes (public list) ----
app.get("/api/nodes", async (c) => {
  const res = await query(
    `SELECT id, name, region, public_ip, wg_listen_port, status, capacity,
            (SELECT count(*)::int FROM devices d WHERE d.node_id = nodes.id AND d.revoked_at IS NULL) AS used
     FROM nodes WHERE status = 'active' ORDER BY region, name`,
  );
  return c.json({ nodes: res.rows });
});

// ---- Devices ----
app.get("/api/devices", authMiddleware, async (c) => {
  const user = c.get("user");
  const res = await query(
    `SELECT d.id, d.name, d.assigned_ipv4, d.wg_public_key, d.created_at, d.revoked_at,
            n.name AS node_name, n.region, n.public_ip
     FROM devices d JOIN nodes n ON n.id = d.node_id
     WHERE d.user_id = $1
     ORDER BY d.created_at DESC`,
    [user.userId],
  );
  return c.json({ devices: res.rows });
});

const deviceCreateSchema = z.object({
  name: z.string().min(1).max(64).default("My device"),
  nodeId: z.string().uuid().optional(),
});

app.post("/api/devices", authMiddleware, async (c) => {
  const user = c.get("user");
  const body = deviceCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const sub = await query<{ status: string; device_limit: number }>(
    `SELECT status, device_limit FROM subscriptions WHERE user_id = $1`,
    [user.userId],
  );
  const subscription = sub.rows[0];
  if (!subscription || subscription.status !== "active") {
    return c.json({ error: "active subscription required" }, 402);
  }

  const count = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM devices WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.userId],
  );
  if ((count.rows[0]?.n || 0) >= subscription.device_limit) {
    return c.json({ error: "device limit reached" }, 403);
  }

  let nodeQuery;
  if (body.data.nodeId) {
    nodeQuery = await query(
      `SELECT * FROM nodes WHERE id = $1 AND status = 'active'`,
      [body.data.nodeId],
    );
  } else {
    nodeQuery = await query(
      `SELECT * FROM nodes WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`,
    );
  }
  const node = nodeQuery.rows[0];
  if (!node) return c.json({ error: "no active VPN nodes" }, 503);

  const usedRows = await query<{ assigned_ipv4: string }>(
    `SELECT assigned_ipv4 FROM devices WHERE node_id = $1 AND revoked_at IS NULL`,
    [node.id],
  );
  const used = new Set(usedRows.rows.map((r) => r.assigned_ipv4));
  // Reserve typical server address inside the pool
  const base = String(node.wg_subnet_cidr).split("/")[0].split(".");
  if (base.length === 4) used.add(`${base[0]}.${base[1]}.0.1`);

  const ip = nextIpv4(node.wg_subnet_cidr, used);
  const keys = generateWireGuardKeypair();

  const ins = await query<{ id: string }>(
    `INSERT INTO devices (user_id, node_id, name, wg_public_key, wg_private_key_enc, assigned_ipv4)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [user.userId, node.id, body.data.name, keys.publicKey, keys.privateKey, ip],
  );

  const endpoint = `${node.public_ip}:${node.wg_listen_port}`;
  const conf = buildClientConfig({
    clientPrivateKey: keys.privateKey,
    clientAddress: `${ip}/32`,
    dns: DNS,
    serverPublicKey: node.wg_public_key,
    endpoint,
  });
  const qr = await QRCode.toDataURL(conf, { margin: 1, width: 280 });

  return c.json(
    {
      device: {
        id: ins.rows[0].id,
        name: body.data.name,
        assigned_ipv4: ip,
        node: { id: node.id, name: node.name, region: node.region, endpoint },
      },
      config: conf,
      qrDataUrl: qr,
      note: "Store the private key now. Re-download uses stored key on this server (P0).",
    },
    201,
  );
});

app.get("/api/devices/:id/config", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const res = await query(
    `SELECT d.*, n.public_ip, n.wg_listen_port, n.wg_public_key
     FROM devices d JOIN nodes n ON n.id = d.node_id
     WHERE d.id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL`,
    [id, user.userId],
  );
  const d = res.rows[0];
  if (!d) return c.json({ error: "not found" }, 404);
  if (!d.wg_private_key_enc) return c.json({ error: "private key not retained" }, 410);

  const conf = buildClientConfig({
    clientPrivateKey: d.wg_private_key_enc,
    clientAddress: `${d.assigned_ipv4}/32`,
    dns: DNS,
    serverPublicKey: d.wg_public_key,
    endpoint: `${d.public_ip}:${d.wg_listen_port}`,
  });
  const format = c.req.query("format");
  if (format === "text" || c.req.header("accept")?.includes("text/plain")) {
    return c.text(conf, 200, {
      "Content-Disposition": `attachment; filename="privateroute-${d.name}.conf"`,
    });
  }
  const qr = await QRCode.toDataURL(conf, { margin: 1, width: 280 });
  return c.json({ config: conf, qrDataUrl: qr });
});

app.delete("/api/devices/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const res = await query(
    `UPDATE devices SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [id, user.userId],
  );
  if (!res.rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---- Agent API (node pulls desired peers) ----
function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function authNode(c: Parameters<typeof authMiddleware>[0]) {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const tokenHash = hashToken(token);
  const res = await query(`SELECT * FROM nodes WHERE agent_token_hash = $1`, [tokenHash]);
  return res.rows[0] || null;
}

app.get("/api/agent/peers", async (c) => {
  const node = await authNode(c);
  if (!node) return c.json({ error: "unauthorized" }, 401);
  await query(`UPDATE nodes SET last_seen_at = now() WHERE id = $1`, [node.id]);
  const peers = await query(
    `SELECT wg_public_key, assigned_ipv4 FROM devices
     WHERE node_id = $1 AND revoked_at IS NULL`,
    [node.id],
  );
  return c.json({
    nodeId: node.id,
    peers: peers.rows.map((p) => ({
      publicKey: p.wg_public_key,
      allowedIps: `${p.assigned_ipv4}/32`,
    })),
  });
});

app.post("/api/agent/heartbeat", async (c) => {
  const node = await authNode(c);
  if (!node) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  await query(`UPDATE nodes SET last_seen_at = now() WHERE id = $1`, [node.id]);
  return c.json({ ok: true, received: body });
});

// ---- Bootstrap node registration (one-time ops) ----
app.post("/api/admin/bootstrap-node", async (c) => {
  const token = c.req.header("x-bootstrap-token");
  if (token !== BOOTSTRAP_TOKEN) return c.json({ error: "forbidden" }, 403);

  const schema = z.object({
    name: z.string().default("primary"),
    region: z.string().default("auto"),
    publicIp: z.string().min(3),
    wgPublicKey: z.string().min(20),
    wgListenPort: z.number().int().default(51820),
    wgSubnetCidr: z.string().default("10.64.0.0/16"),
    agentToken: z.string().min(16).optional(),
  });
  const body = schema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const agentToken = body.data.agentToken || randomBytes(24).toString("hex");
  const agent_token_hash = hashToken(agentToken);

  // Upsert by public IP
  const existing = await query(`SELECT id FROM nodes WHERE public_ip = $1`, [body.data.publicIp]);
  let nodeId: string;
  if (existing.rowCount) {
    const upd = await query<{ id: string }>(
      `UPDATE nodes SET name=$1, region=$2, wg_public_key=$3, wg_listen_port=$4,
        wg_subnet_cidr=$5, agent_token_hash=$6, status='active', last_seen_at=now()
       WHERE public_ip=$7 RETURNING id`,
      [
        body.data.name,
        body.data.region,
        body.data.wgPublicKey,
        body.data.wgListenPort,
        body.data.wgSubnetCidr,
        agent_token_hash,
        body.data.publicIp,
      ],
    );
    nodeId = upd.rows[0].id;
  } else {
    const ins = await query<{ id: string }>(
      `INSERT INTO nodes (name, region, public_ip, wg_public_key, wg_listen_port, wg_subnet_cidr, agent_token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        body.data.name,
        body.data.region,
        body.data.publicIp,
        body.data.wgPublicKey,
        body.data.wgListenPort,
        body.data.wgSubnetCidr,
        agent_token_hash,
      ],
    );
    nodeId = ins.rows[0].id;
  }

  return c.json({ nodeId, agentToken });
});

// Stripe stub endpoints (P1 ready)
app.post("/api/billing/checkout", authMiddleware, async (c) => {
  if (AUTO_ACTIVATE) {
    const user = c.get("user");
    await query(
      `INSERT INTO subscriptions (user_id, plan, status, device_limit)
       VALUES ($1, 'solo', 'active', 5)
       ON CONFLICT (user_id) DO UPDATE SET status = 'active', plan = 'solo'`,
      [user.userId],
    );
    return c.json({
      mode: "auto",
      message: "Subscription activated (P0 AUTO_ACTIVATE). Wire Stripe in P1.",
      url: null,
    });
  }
  return c.json({ error: "Stripe not configured" }, 501);
});

// Static dashboard (apps/web/public)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot =
  process.env.WEB_ROOT ||
  path.resolve(__dirname, "../../web/public");

app.use("/*", serveStatic({ root: webRoot }));
app.get("/", serveStatic({ path: path.join(webRoot, "index.html") }));

console.log(`PrivateRoute API listening on :${PORT} (web: ${webRoot})`);
serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" });
