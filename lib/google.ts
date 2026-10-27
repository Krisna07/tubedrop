import { db, decrypt, encrypt, env } from "./util.js";

export class ToolError extends Error {}

/** kind "drive" = the personal Google account; kind "yt" = the account/brand channel picked for YouTube. */
export async function accessToken(userId: string, kind: "yt" | "drive" = "yt"): Promise<string> {
  const sql = await db();
  const rows = await sql`SELECT * FROM users WHERE id = ${userId}`;
  const u = rows[0];
  if (!u) throw new ToolError("No Google account is linked. Reconnect the connector in Claude's settings.");
  const useYt = kind === "yt" && !!u.yt_refresh_enc;
  const refreshEnc = useYt ? u.yt_refresh_enc : u.google_refresh_enc;
  const accessEnc = useYt ? u.yt_access_enc : u.google_access_enc;
  const expiry = useYt ? u.yt_expiry : u.google_expiry;
  if (accessEnc && expiry && new Date(expiry) > new Date()) return decrypt(accessEnc);
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
  const enc = encrypt(t.access_token);
  const exp = new Date(Date.now() + (t.expires_in ?? 3600) * 1000 - 60000).toISOString();
  if (useYt) await sql`UPDATE users SET yt_access_enc = ${enc}, yt_expiry = ${exp}, updated_at = now() WHERE id = ${userId}`;
  else await sql`UPDATE users SET google_access_enc = ${enc}, google_expiry = ${exp}, updated_at = now() WHERE id = ${userId}`;
  return t.access_token;
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
