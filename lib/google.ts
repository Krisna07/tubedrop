import { db, decrypt, encrypt, env } from "./util.js";

export class ToolError extends Error {}

async function refreshGoogle(refreshEnc: string): Promise<{ token: string; enc: string; exp: string }> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: decrypt(refreshEnc),
      grant_type: "refresh_token",
    }),
  });
  const t = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!r.ok || !t.access_token) {
    throw new ToolError(`Google sign-in has expired (${t.error ?? r.status}). Disconnect and reconnect the connector in Claude's settings.`);
  }
  return { token: t.access_token, enc: encrypt(t.access_token), exp: new Date(Date.now() + (t.expires_in ?? 3600) * 1000 - 60000).toISOString() };
}

const live = (accessEnc: unknown, expiry: unknown) => !!accessEnc && !!expiry && new Date(expiry as string) > new Date();

/**
 * kind "drive" = the personal Google account; kind "yt" = a linked YouTube channel.
 * channelId picks which linked channel; without it the active one (users.channel_id) is used.
 * Each channel caches its own access token, so calls for different channels never share one.
 */
export async function accessToken(userId: string, kind: "yt" | "drive" = "yt", channelId?: string | null): Promise<string> {
  const sql = await db();
  const rows = await sql`SELECT * FROM users WHERE id = ${userId}`;
  const u = rows[0];
  if (!u) throw new ToolError("No Google account is linked. Reconnect the connector in Claude's settings.");
  if (kind === "yt") {
    const cid = channelId ?? u.channel_id;
    const c = cid ? (await sql`SELECT * FROM channels WHERE user_id = ${userId} AND channel_id = ${cid}`)[0] : undefined;
    if (channelId && !c && channelId !== u.channel_id) throw new ToolError(`Channel ${channelId} is not linked to this connector. Use list_channels.`);
    if (c) {
      if (live(c.yt_access_enc, c.yt_expiry)) return decrypt(c.yt_access_enc);
      const f = await refreshGoogle(c.yt_refresh_enc);
      await sql`UPDATE channels SET yt_access_enc = ${f.enc}, yt_expiry = ${f.exp} WHERE user_id = ${userId} AND channel_id = ${cid}`;
      return f.token;
    }
  }
  // Drive, or an account linked before channels had their own rows.
  const useYt = kind === "yt" && !!u.yt_refresh_enc;
  const refreshEnc = useYt ? u.yt_refresh_enc : u.google_refresh_enc;
  if (live(useYt ? u.yt_access_enc : u.google_access_enc, useYt ? u.yt_expiry : u.google_expiry)) return decrypt(useYt ? u.yt_access_enc : u.google_access_enc);
  const f = await refreshGoogle(refreshEnc);
  // Only cache against the refresh token that produced it, so a concurrent change cannot be given the wrong token.
  if (useYt) await sql`UPDATE users SET yt_access_enc = ${f.enc}, yt_expiry = ${f.exp}, updated_at = now() WHERE id = ${userId} AND yt_refresh_enc = ${refreshEnc}`;
  else await sql`UPDATE users SET google_access_enc = ${f.enc}, google_expiry = ${f.exp}, updated_at = now() WHERE id = ${userId} AND google_refresh_enc = ${refreshEnc}`;
  return f.token;
}

export async function gfetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

export async function gjson<T = any>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await gfetch(token, url, init);
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const msg = body?.error?.message ?? body?.error_description ?? text.slice(0, 300);
    const reason = body?.error?.errors?.[0]?.reason;
    throw new ToolError(`Google API error ${r.status}${reason ? ` (${reason})` : ""}: ${msg}`);
  }
  return body as T;
}

// ---------------------------------------------------------------- Drive

export function driveId(ref: string): string {
  const s = ref.trim();
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  throw new ToolError(`"${ref}" is not a Google Drive file ID or link.`);
}

export interface DriveFile { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }

export async function driveMeta(token: string, id: string): Promise<DriveFile> {
  return gjson<DriveFile>(token, `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`);
}

export async function driveSearch(token: string, query: string, kind: string): Promise<DriveFile[]> {
  const parts = ["trashed = false"];
  if (query) parts.push(`name contains '${query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
  if (kind === "video") parts.push("mimeType contains 'video/'");
  if (kind === "image") parts.push("mimeType contains 'image/'");
  const u = new URL("https://www.googleapis.com/drive/v3/files");
  u.searchParams.set("q", parts.join(" and "));
  u.searchParams.set("fields", "files(id,name,mimeType,size,modifiedTime)");
  u.searchParams.set("orderBy", "modifiedTime desc");
  u.searchParams.set("pageSize", "25");
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  const r = await gjson<{ files: DriveFile[] }>(token, u.toString());
  return r.files;
}

export async function driveBytes(token: string, id: string, range?: [number, number]): Promise<ArrayBuffer> {
  const r = await gfetch(token, `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, {
    headers: range ? { range: `bytes=${range[0]}-${range[1]}` } : {},
  });
  if (!r.ok && r.status !== 206) throw new ToolError(`Could not read the Drive file (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return r.arrayBuffer();
}
