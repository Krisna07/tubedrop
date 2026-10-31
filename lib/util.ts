import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";

// ---------------------------------------------------------------- env

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export function baseUrl(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? u.host;
  return `https://${host}`;
}

// ---------------------------------------------------------------- crypto

export const randomId = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const b64urlSha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function key(): Buffer {
  const k = Buffer.from(env("ENC_KEY"), "base64");
  if (k.length !== 32) throw new Error("ENC_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, body] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------- db

let _sql: ReturnType<typeof neon> | null = null;
let _migrated = false;

export async function db() {
  const injected = (globalThis as any).__uploaderSql;          // tests run against an in-process Postgres
  if (injected) {
    if (!_migrated) { await migrate(injected); _migrated = true; }
    return injected as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, any>[]>;
  }
  if (!_sql) _sql = neon(env("DATABASE_URL"));
  if (!_migrated) {
    await migrate(_sql as any);
    _migrated = true;
  }
  return _sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, any>[]>;
}

async function migrate(s: any) {
  {
    await s`CREATE TABLE IF NOT EXISTS clients (client_id text PRIMARY KEY, redirect_uris jsonb NOT NULL, client_name text, created_at timestamptz DEFAULT now())`;
    await s`CREATE TABLE IF NOT EXISTS pending (state text PRIMARY KEY, client_id text NOT NULL, redirect_uri text NOT NULL, code_challenge text NOT NULL, client_state text, created_at timestamptz DEFAULT now())`;
    await s`CREATE TABLE IF NOT EXISTS codes (code_hash text PRIMARY KEY, client_id text NOT NULL, redirect_uri text NOT NULL, code_challenge text NOT NULL, user_id text NOT NULL, expires_at timestamptz NOT NULL)`;
    await s`CREATE TABLE IF NOT EXISTS tokens (token_hash text PRIMARY KEY, kind text NOT NULL, user_id text NOT NULL, client_id text NOT NULL, expires_at timestamptz NOT NULL)`;
    await s`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, email text, channel_id text, channel_title text, google_refresh_enc text, google_access_enc text, google_expiry timestamptz, updated_at timestamptz DEFAULT now())`;
    await s`CREATE TABLE IF NOT EXISTS jobs (id text PRIMARY KEY, user_id text NOT NULL, drive_id text NOT NULL, session_uri_enc text, total bigint, uploaded bigint DEFAULT 0, mime text, meta jsonb, extras jsonb, status text NOT NULL, video_id text, error text, updated_at timestamptz DEFAULT now())`;
    // Columns added after the first release; a fresh database needs them too.
    await s`ALTER TABLE pending ADD COLUMN IF NOT EXISTS stage text`;
    await s`ALTER TABLE pending ADD COLUMN IF NOT EXISTS user_id text`;
    await s`ALTER TABLE users ADD COLUMN IF NOT EXISTS yt_refresh_enc text`;
    await s`ALTER TABLE users ADD COLUMN IF NOT EXISTS yt_access_enc text`;
    await s`ALTER TABLE users ADD COLUMN IF NOT EXISTS yt_expiry timestamptz`;
    await s`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind text`;
    // Instagram (optional): one linked professional account per user, and one-time connect links.
    await s`CREATE TABLE IF NOT EXISTS instagram_accounts (user_id text PRIMARY KEY, ig_user_id text NOT NULL, username text, token_enc text NOT NULL, token_expiry timestamptz NOT NULL, refreshed_at timestamptz NOT NULL)`;
    await s`CREATE TABLE IF NOT EXISTS ig_links (state text PRIMARY KEY, user_id text NOT NULL, created_at timestamptz DEFAULT now())`;
  }
}

// ---------------------------------------------------------------- http

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

export const redirect = (url: string) => new Response(null, { status: 302, headers: { location: url } });

export function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TubeDrop</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#222}
h1{font-size:22px}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function formOrJson(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await req.json()) as Record<string, string>;
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
