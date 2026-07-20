import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

/** WireGuard uses Curve25519 keys as base64 of 32 raw bytes (not PEM). */
export function generateWireGuardKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");

  const privDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  // PKCS8 for X25519: last 32 bytes are the raw private key
  const privRaw = privDer.subarray(privDer.length - 32);

  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  // SPKI for X25519: last 32 bytes are the raw public key
  const pubRaw = pubDer.subarray(pubDer.length - 32);

  return {
    privateKey: privRaw.toString("base64"),
    publicKey: pubRaw.toString("base64"),
  };
}

export function publicKeyFromPrivate(privateKeyB64: string): string {
  // Reconstruct PKCS8 and derive public — for validation only
  const raw = Buffer.from(privateKeyB64, "base64");
  if (raw.length !== 32) throw new Error("invalid private key length");
  // Minimal PKCS8 prefix for X25519 private key
  const pkcs8Prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  const der = Buffer.concat([pkcs8Prefix, raw]);
  const keyObj = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pub = createPublicKey(keyObj);
  const pubDer = pub.export({ type: "spki", format: "der" }) as Buffer;
  return pubDer.subarray(pubDer.length - 32).toString("base64");
}

export function buildClientConfig(opts: {
  clientPrivateKey: string;
  clientAddress: string;
  dns: string;
  serverPublicKey: string;
  endpoint: string;
  allowedIps?: string;
  keepalive?: number;
}): string {
  const allowed = opts.allowedIps ?? "0.0.0.0/0, ::/0";
  const ka = opts.keepalive ?? 25;
  return `[Interface]
PrivateKey = ${opts.clientPrivateKey}
Address = ${opts.clientAddress}
DNS = ${opts.dns}

[Peer]
PublicKey = ${opts.serverPublicKey}
AllowedIPs = ${allowed}
Endpoint = ${opts.endpoint}
PersistentKeepalive = ${ka}
`;
}

/** Allocate next /32 from a /16 pool based on existing assignments. */
export function nextIpv4(subnetCidr: string, used: Set<string>): string {
  // Expect 10.x.0.0/16 style
  const [base] = subnetCidr.split("/");
  const parts = base.split(".").map(Number);
  if (parts.length !== 4) throw new Error("invalid subnet");
  // Start at .0.2 (reserve .0.1 for server)
  for (let third = 0; third < 256; third++) {
    for (let fourth = third === 0 ? 2 : 1; fourth < 255; fourth++) {
      const ip = `${parts[0]}.${parts[1]}.${third}.${fourth}`;
      if (!used.has(ip)) return ip;
    }
  }
  throw new Error("IP pool exhausted");
}
