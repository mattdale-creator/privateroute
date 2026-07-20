import { pool } from "./db.js";

const sql = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'solo',
  status TEXT NOT NULL DEFAULT 'active',
  device_limit INT NOT NULL DEFAULT 5,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  public_ip TEXT NOT NULL,
  wg_public_key TEXT NOT NULL,
  wg_listen_port INT NOT NULL DEFAULT 51820,
  wg_subnet_cidr TEXT NOT NULL DEFAULT '10.64.0.0/16',
  agent_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  capacity INT NOT NULL DEFAULT 250,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES nodes(id),
  name TEXT NOT NULL,
  wg_public_key TEXT NOT NULL,
  wg_private_key_enc TEXT,
  assigned_ipv4 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (wg_public_key)
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_node ON devices(node_id);
`;

async function main() {
  await pool.query(sql);

  // Seed demo user for zero-touch smoke tests (password: password123)
  const bcrypt = await import("bcryptjs");
  const demoEmail = process.env.DEMO_EMAIL || "demo@privateroute.local";
  const demoPass = process.env.DEMO_PASSWORD || "password123";
  const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [demoEmail]);
  if (!existing.rowCount) {
    const hash = await bcrypt.hash(demoPass, 12);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [demoEmail, hash],
    );
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, device_limit)
       VALUES ($1, 'solo', 'active', 5)
       ON CONFLICT (user_id) DO NOTHING`,
      [u.rows[0].id],
    );
    console.log(`Seeded demo user ${demoEmail}`);
  }

  console.log("Migrations applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
