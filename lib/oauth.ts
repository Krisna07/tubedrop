import { b64urlSha256, baseUrl, db, encrypt, env, escapeHtml, formOrJson, html, json, randomId, redirect, sha256 } from "./util.js";

// Two Google sign-ins: the personal account for Drive (brand accounts have no Drive), then the
// account or brand channel that owns the YouTube channel.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const YT_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"; // write into the app's own upload folder

const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 60 * 60 * 24 * 60;
const ALLOWED_REDIRECT_HOSTS = ["claude.ai", "claude.com", "localhost", "127.0.0.1"];

function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" && !(u.hostname === "localhost" || u.hostname === "127.0.0.1")) return false;
    return ALLOWED_REDIRECT_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch {
    return false;
  }
}

function googleUrl(req: Request, scopes: string[], state: string, hint?: string): string {
  const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  g.searchParams.set("client_id", env("GOOGLE_CLIENT_ID"));
  g.searchParams.set("redirect_uri", `${baseUrl(req)}/google/callback`);
  g.searchParams.set("response_type", "code");
  g.searchParams.set("scope", scopes.join(" "));
  g.searchParams.set("access_type", "offline");
  g.searchParams.set("prompt", "consent select_account");
  g.searchParams.set("state", state);
  if (hint) g.searchParams.set("login_hint", hint);
  return g.toString();
}

export function protectedResourceMetadata(req: Request) {
  const base = baseUrl(req);
  return json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ["youtube"],
    bearer_methods_supported: ["header"],
    resource_name: "TubeDrop",
  });
}

export function authServerMetadata(req: Request) {
  const base = baseUrl(req);
  return json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["youtube"],
    client_id_metadata_document_supported: true,
  });
}

export async function register(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { redirect_uris?: string[]; client_name?: string };
  const uris = (body.redirect_uris ?? []).filter((u) => typeof u === "string");
  if (!uris.length || !uris.every(redirectAllowed)) {
    return json({ error: "invalid_redirect_uri", error_description: "Only Claude redirect URIs are accepted." }, 400);
  }
  const sql = await db();
  const id = "c_" + randomId(16);
  await sql`INSERT INTO clients (client_id, redirect_uris, client_name) VALUES (${id}, ${JSON.stringify(uris)}, ${body.client_name ?? null})`;
  return json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      client_name: body.client_name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

async function clientRedirects(clientId: string): Promise<string[] | null> {
  if (clientId.startsWith("https://")) {
    try {
      const host = new URL(clientId).hostname;
      if (!ALLOWED_REDIRECT_HOSTS.some((h) => host === h || host.endsWith("." + h))) return null;
      const r = await fetch(clientId, { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const doc = (await r.json()) as { client_id?: string; redirect_uris?: string[] };
      if (doc.client_id && doc.client_id !== clientId) return null;
      return (doc.redirect_uris ?? []).filter(redirectAllowed);
    } catch {
      return null;
    }
  }
  const sql = await db();
  const rows = await sql`SELECT redirect_uris FROM clients WHERE client_id = ${clientId}`;
  return rows.length ? (rows[0].redirect_uris as string[]) : null;
}

export async function authorize(req: Request) {
  const q = new URL(req.url).searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("response_type") !== "code") return html("<h1>Unsupported response_type</h1>", 400);
  if (q.get("code_challenge_method") !== "S256" || !challenge) return html("<h1>PKCE (S256) is required</h1>", 400);
  const preRegistered = clientId === process.env.GOOGLE_CLIENT_ID && redirectAllowed(redirectUri);
  const allowed = preRegistered ? [redirectUri] : await clientRedirects(clientId);
  if (!allowed || !allowed.includes(redirectUri)) return html("<h1>Unknown client or redirect URI</h1>", 400);

  const sql = await db();
  const state = randomId(24);
  await sql`DELETE FROM pending WHERE created_at < now() - interval '15 minutes'`;
  await sql`INSERT INTO pending (state, client_id, redirect_uri, code_challenge, client_state)
            VALUES (${state}, ${clientId}, ${redirectUri}, ${challenge}, ${q.get("state")})`;
  return redirect(googleUrl(req, ["openid", "email", DRIVE_SCOPE, DRIVE_FILE_SCOPE], state));
}

export async function googleCallback(req: Request) {
  const q = new URL(req.url).searchParams;
  if (q.get("error")) return html(`<h1>Sign-in cancelled</h1><p>${escapeHtml(q.get("error")!)}</p>`, 400);
  const sql = await db();
  const rows = await sql`DELETE FROM pending WHERE state = ${q.get("state") ?? ""} RETURNING *`;
  if (!rows.length) return html("<h1>This sign-in link has expired</h1><p>Go back to Claude and press Connect again.</p>", 400);
  const p = rows[0];

  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: q.get("code") ?? "",
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: `${baseUrl(req)}/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  const t = (await tok.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; scope?: string; error?: string; error_description?: string };
  if (!tok.ok || !t.access_token) return html(`<h1>Google sign-in failed</h1><p>${escapeHtml(t.error ?? "unknown error")}: ${escapeHtml(t.error_description ?? "")}</p>`, 400);
  const granted = (t.scope ?? "").split(" ");
  const expiry = new Date(Date.now() + (t.expires_in ?? 3600) * 1000 - 60000).toISOString();

  if (p.stage === "yt") {
    // Step 2: the YouTube channel (personal or brand account).
    if (!granted.includes(YT_SCOPE)) return html("<h1>YouTube permission was not granted</h1><p>Press Connect again and tick the YouTube box.</p>", 400);
    const ch = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: `Bearer ${t.access_token}` } });
    const chJson = (await ch.json()) as { items?: { id: string; snippet: { title: string } }[] };
    const channel = chJson.items?.[0];
    if (!channel) return html("<h1>That account has no YouTube channel</h1><p>Go back to Claude, press Connect again, and on the second Google screen pick the YouTube channel you want to upload to.</p>", 400);
    const existing = await sql`SELECT yt_refresh_enc FROM users WHERE id = ${p.user_id}`;
    const ytRefresh = t.refresh_token ? encrypt(t.refresh_token) : existing[0]?.yt_refresh_enc ?? null;
    if (!ytRefresh) return html("<h1>Google did not return offline access</h1><p>Remove the app at myaccount.google.com/permissions and connect again.</p>", 400);
    await sql`UPDATE users SET yt_refresh_enc = ${ytRefresh}, yt_access_enc = ${encrypt(t.access_token)}, yt_expiry = ${expiry},
              channel_id = ${channel.id}, channel_title = ${channel.snippet.title}, updated_at = now() WHERE id = ${p.user_id}`;
    const code = randomId(32);
    await sql`INSERT INTO codes (code_hash, client_id, redirect_uri, code_challenge, user_id, expires_at)
              VALUES (${sha256(code)}, ${p.client_id}, ${p.redirect_uri}, ${p.code_challenge}, ${p.user_id}, now() + interval '5 minutes')`;
    const back = new URL(p.redirect_uri);
    back.searchParams.set("code", code);
    if (p.client_state) back.searchParams.set("state", p.client_state);
    return redirect(back.toString());
  }

  // Step 1: the personal Google account (identity + Drive).
  if (!granted.includes(DRIVE_SCOPE) || !granted.includes(DRIVE_FILE_SCOPE)) return html("<h1>Google Drive permission was not granted</h1><p>Press Connect again and tick the Google Drive box.</p>", 400);
  const claims = JSON.parse(Buffer.from((t.id_token ?? "..").split(".")[1] ?? "", "base64url").toString() || "{}") as { sub?: string; email?: string };
  if (!claims.sub) return html("<h1>Google did not return an account id</h1>", 400);
  const allowed = (process.env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes((claims.email ?? "").toLowerCase())) {
    return html("<h1>This connector is private</h1><p>The Google account you chose is not allowed to use it.</p>", 403);
  }
  const existing = await sql`SELECT google_refresh_enc FROM users WHERE id = ${claims.sub}`;
  const refreshEnc = t.refresh_token ? encrypt(t.refresh_token) : existing[0]?.google_refresh_enc ?? null;
  if (!refreshEnc) return html("<h1>Google did not return offline access</h1><p>Remove the app at myaccount.google.com/permissions and connect again.</p>", 400);
  await sql`INSERT INTO users (id, email, google_refresh_enc, google_access_enc, google_expiry, updated_at)
            VALUES (${claims.sub}, ${claims.email ?? null}, ${refreshEnc}, ${encrypt(t.access_token)}, ${expiry}, now())
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, google_refresh_enc = EXCLUDED.google_refresh_enc,
              google_access_enc = EXCLUDED.google_access_enc, google_expiry = EXCLUDED.google_expiry, updated_at = now()`;
  const state = randomId(24);
  await sql`INSERT INTO pending (state, client_id, redirect_uri, code_challenge, client_state, stage, user_id)
            VALUES (${state}, ${p.client_id}, ${p.redirect_uri}, ${p.code_challenge}, ${p.client_state}, 'yt', ${claims.sub})`;
  return redirect(googleUrl(req, [YT_SCOPE], state, claims.email));
}

async function issue(userId: string, clientId: string) {
  const sql = await db();
  const access = "at_" + randomId(32);
  const refresh = "rt_" + randomId(32);
  await sql`INSERT INTO tokens (token_hash, kind, user_id, client_id, expires_at) VALUES
            (${sha256(access)}, 'access', ${userId}, ${clientId}, now() + make_interval(secs => ${ACCESS_TTL})),
            (${sha256(refresh)}, 'refresh', ${userId}, ${clientId}, now() + make_interval(secs => ${REFRESH_TTL}))`;
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: "youtube" });
}

export async function token(req: Request) {
  const f = await formOrJson(req);
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (basic && !f.client_id) f.client_id = decodeURIComponent(Buffer.from(basic[1], "base64").toString().split(":")[0]);
  const sql = await db();
  if (f.grant_type === "authorization_code") {
    const rows = await sql`DELETE FROM codes WHERE code_hash = ${sha256(f.code ?? "")} RETURNING *`;
    const c = rows[0];
    if (!c || new Date(c.expires_at) < new Date()) return json({ error: "invalid_grant" }, 400);
    if (c.client_id !== f.client_id || c.redirect_uri !== f.redirect_uri) return json({ error: "invalid_grant" }, 400);
    if (b64urlSha256(f.code_verifier ?? "") !== c.code_challenge) return json({ error: "invalid_grant", error_description: "PKCE check failed" }, 400);
    return issue(c.user_id, c.client_id);
  }
  if (f.grant_type === "refresh_token") {
    const rows = await sql`DELETE FROM tokens WHERE token_hash = ${sha256(f.refresh_token ?? "")} AND kind = 'refresh' RETURNING *`;
    const r = rows[0];
    if (!r || new Date(r.expires_at) < new Date() || (f.client_id && f.client_id !== r.client_id)) return json({ error: "invalid_grant" }, 400);
    return issue(r.user_id, r.client_id);
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

export async function authenticate(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const sql = await db();
  const rows = await sql`SELECT user_id FROM tokens WHERE token_hash = ${sha256(m[1])} AND kind = 'access' AND expires_at > now()`;
  return rows[0]?.user_id ?? null;
}
