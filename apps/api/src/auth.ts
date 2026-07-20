import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const encoder = new TextEncoder();

function secret() {
  const s = process.env.JWT_SECRET || "dev-only-change-me-privateroute-p0";
  return encoder.encode(s);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function signToken(userId: string, email: string) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());
}

export async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, secret());
  if (!payload.sub) throw new Error("invalid token");
  return { userId: payload.sub, email: String(payload.email || "") };
}

export type Authed = { userId: string; email: string };

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("authorization");
  let token: string | undefined;
  if (header?.startsWith("Bearer ")) token = header.slice(7);
  if (!token) token = getCookie(c, "pr_session") || undefined;
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const user = await verifyToken(token);
    c.set("user", user);
    await next();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, "pr_session", token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.COOKIE_SECURE === "1",
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, "pr_session", { path: "/" });
}
