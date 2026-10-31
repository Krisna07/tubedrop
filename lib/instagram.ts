import { accessToken, gfetch, ToolError } from "./google.js";
import { baseUrl, db, decrypt, encrypt, env, escapeHtml, html, randomId, redirect, safeEqual, sha256 } from "./util.js";

// Instagram API with Instagram Login (Business or Creator accounts). Linking is optional and separate
// from the Claude sign-in: the instagram_connect tool hands out a one-time link to /instagram/connect.
const IG_VERSION = process.env.IG_API_VERSION ?? "v26.0";
export const IG_GRAPH = `https://graph.instagram.com/${IG_VERSION}`;
const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;            // Meta only refreshes tokens at least 24 h old

export const instagramEnabled = () => !!process.env.INSTAGRAM_APP_ID;

type Json = Record<string, any>;
const unwrap = (j: Json) => (Array.isArray(j?.data) ? j.data[0] ?? {} : j);

async function igJson<T = Json>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, init);
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok || body?.error || body?.error_type) {
    const msg = body?.error?.message ?? body?.error_message ?? (typeof body === "string" ? body.slice(0, 300) : r.status);
    throw new ToolError(`Instagram API error ${r.status}: ${msg}`);
  }
  return body as T;
}

// ---------------------------------------------------------------- account linking

export async function connectLink(req: Request, userId: string): Promise<string> {
  const sql = await db();
  const t = randomId(24);
  await sql`DELETE FROM ig_links WHERE created_at < now() - interval '30 minutes'`;
  await sql`INSERT INTO ig_links (state, user_id) VALUES (${sha256(t)}, ${userId})`;
  return `${baseUrl(req)}/instagram/connect?t=${t}`;
}

export async function connectStart(req: Request) {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const sql = await db();
  const rows = await sql`SELECT state FROM ig_links WHERE state = ${sha256(t)} AND created_at > now() - interval '30 minutes'`;
  if (!rows.length) return html("<h1>This link has expired</h1><p>Ask Claude for a new Instagram connect link.</p>", 400);
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", env("INSTAGRAM_APP_ID"));
  u.searchParams.set("redirect_uri", `${baseUrl(req)}/instagram/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", IG_SCOPES.join(","));
  u.searchParams.set("state", t);
  return redirect(u.toString());
}

export async function connectCallback(req: Request) {
  const q = new URL(req.url).searchParams;
  if (q.get("error")) return html(`<h1>Instagram sign-in cancelled</h1><p>${escapeHtml(q.get("error_description") ?? q.get("error")!)}</p>`, 400);
  const sql = await db();
  const links = await sql`DELETE FROM ig_links WHERE state = ${sha256(q.get("state") ?? "")} AND created_at > now() - interval '30 minutes' RETURNING user_id`;
  if (!links.length) return html("<h1>This link has expired</h1><p>Ask Claude for a new Instagram connect link.</p>", 400);
  const userId = links[0].user_id as string;
  try {
    const short = unwrap(await igJson("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("INSTAGRAM_APP_ID"),
        client_secret: env("INSTAGRAM_APP_SECRET"),
        grant_type: "authorization_code",
        redirect_uri: `${baseUrl(req)}/instagram/callback`,
        code: (q.get("code") ?? "").replace(/#_$/, ""),
      }),
    }));
    const granted = String(short.permissions ?? "").split(",").map((s) => s.trim());
    if (short.permissions && !granted.includes("instagram_business_content_publish"))
      return html("<h1>Publishing permission was not granted</h1><p>Ask Claude for a new link and allow content publishing.</p>", 400);
    const ex = new URL("https://graph.instagram.com/access_token");
    ex.searchParams.set("grant_type", "ig_exchange_token");
    ex.searchParams.set("client_secret", env("INSTAGRAM_APP_SECRET"));
    ex.searchParams.set("access_token", short.access_token);
    const long = await igJson(ex.toString());
    const me = unwrap(await igJson(`${IG_GRAPH}/me?fields=user_id,username,account_type`, { headers: { authorization: `Bearer ${long.access_token}` } }));
    const igId = String(me.user_id ?? short.user_id);
    const expiry = new Date(Date.now() + Number(long.expires_in ?? 5184000) * 1000).toISOString();
    await sql`INSERT INTO instagram_accounts (user_id, ig_user_id, username, token_enc, token_expiry, refreshed_at)
              VALUES (${userId}, ${igId}, ${me.username ?? null}, ${encrypt(long.access_token)}, ${expiry}, now())
              ON CONFLICT (user_id) DO UPDATE SET ig_user_id = EXCLUDED.ig_user_id, username = EXCLUDED.username,
                token_enc = EXCLUDED.token_enc, token_expiry = EXCLUDED.token_expiry, refreshed_at = now()`;
    return html(`<h1>Instagram connected</h1><p>TubeDrop can now publish Reels to <b>@${escapeHtml(me.username ?? igId)}</b>. You can close this tab and go back to Claude.</p>`);
  } catch (e) {
    return html(`<h1>Instagram sign-in failed</h1><p>${escapeHtml((e as Error).message)}</p>`, 400);
  }
}

export async function igAccount(userId: string) {
  const sql = await db();
  return (await sql`SELECT * FROM instagram_accounts WHERE user_id = ${userId}`)[0] ?? null;
}

/** A valid long-lived token, refreshed (for another 60 days) at most once a day. */
async function igToken(userId: string): Promise<{ token: string; igId: string }> {
  const a = await igAccount(userId);
  if (!a) throw new ToolError("No Instagram account is linked. Call instagram_connect and open the link it returns.");
  if (new Date(a.token_expiry) <= new Date()) throw new ToolError("The Instagram sign-in has expired. Call instagram_connect to link the account again.");
  let token = decrypt(a.token_enc);
  if (Date.now() - new Date(a.refreshed_at).getTime() > REFRESH_AFTER_MS) {
    try {
      const r = await igJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
      token = r.access_token;
      const expiry = new Date(Date.now() + Number(r.expires_in ?? 5184000) * 1000).toISOString();
      const sql = await db();
      await sql`UPDATE instagram_accounts SET token_enc = ${encrypt(token)}, token_expiry = ${expiry}, refreshed_at = now() WHERE user_id = ${userId}`;
    } catch { /* the current token is still valid; try again next time */ }
  }
  return { token, igId: a.ig_user_id };
}

// ---------------------------------------------------------------- media route (Meta fetches the video from here)

/**
 * Instagram Login apps publish from a public URL, so the Drive file is streamed through this route.
 * Each job has its own secret (stored hashed); the route only serves while the job is waiting on Meta.
 */
export async function serveMedia(req: Request, jobId: string, which: string) {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const sql = await db();
  const job = (await sql`SELECT * FROM jobs WHERE id = ${jobId} AND kind = 'ig'`)[0];
  if (!job || job.status !== "processing" || !safeEqual(sha256(t), String(job.meta?.media_secret_hash ?? ""))) return new Response("Not found", { status: 404 });
  const fileId = which === "cover" ? job.extras?.cover_drive_id : which === "video" ? job.drive_id : null;
  if (!fileId) return new Response("Not found", { status: 404 });
  const dr = await accessToken(job.user_id, "drive");
  const range = req.headers.get("range");
  const r = await gfetch(dr, `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: range ? { range } : {} });
  if (!r.ok) return new Response("Upstream error", { status: 502 });
  const headers = new Headers({ "content-type": which === "cover" ? job.extras?.cover_mime ?? "image/jpeg" : job.mime ?? "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" });
  for (const h of ["content-length", "content-range"]) { const v = r.headers.get(h); if (v) headers.set(h, v); }
  return new Response(req.method === "HEAD" ? null : r.body, { status: r.status, headers });
}

// ---------------------------------------------------------------- publishing

type Args = Record<string, any>;
const POLL_MS = Number(process.env.IG_POLL_SECONDS ?? 45) * 1000;
const POLL_EVERY_MS = 5000;

export async function publishReel(base: string, userId: string, a: Args, drive: { id: string; name: string; mimeType: string; size?: string }, cover?: { id: string; mimeType: string }) {
  if (a.user_confirmed !== true)
    throw new ToolError("A published Reel is public straight away. Only call this after the user has clearly said to post it, and pass user_confirmed: true.");
  if (!/^video\/(mp4|quicktime)$/.test(drive.mimeType)) throw new ToolError(`${drive.name} is ${drive.mimeType}; Reels must be MP4 or MOV.`);
  if (Number(drive.size ?? 0) > 300 * 1024 * 1024) throw new ToolError(`${drive.name} is over Instagram's 300 MB limit for Reels.`);
  const caption = String(a.caption ?? "");
  if (caption.length > 2200) throw new ToolError("Caption is longer than 2,200 characters.");
  if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) throw new ToolError("Instagram allows at most 30 hashtags.");
  const { token, igId } = await igToken(userId);
  const sql = await db();
  const jobId = "ig_" + randomId(9);
  const secret = randomId(24);
  const extras = { cover_drive_id: cover?.id, cover_mime: cover?.mimeType, delete_from_drive: a.delete_from_drive !== false, cover_ref: a.cover_drive_file };
  await sql`INSERT INTO jobs (id, user_id, drive_id, total, uploaded, mime, meta, extras, status, kind)
            VALUES (${jobId}, ${userId}, ${drive.id}, ${Number(drive.size ?? 0)}, 0, ${drive.mimeType},
                    ${JSON.stringify({ name: drive.name, media_secret_hash: sha256(secret) })}, ${JSON.stringify(extras)}, 'processing', 'ig')`;
  const media = (which: string) => `${base}/ig/media/${jobId}/${which}?t=${secret}`;
  const body: Args = { media_type: "REELS", video_url: media("video"), caption, share_to_feed: a.share_to_feed !== false };
  if (cover) body.cover_url = media("cover");
  else if (a.thumb_offset_ms !== undefined) body.thumb_offset = Number(a.thumb_offset_ms);
  if (a.is_ai_generated !== undefined) body.is_ai_generated = !!a.is_ai_generated;
  if (Array.isArray(a.collaborators) && a.collaborators.length) body.collaborators = a.collaborators.slice(0, 3);
  let container: { id: string };
  try {
    container = await igJson(`${IG_GRAPH}/${igId}/media`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
  } catch (e) {
    await sql`UPDATE jobs SET status = 'failed', error = ${(e as Error).message.slice(0, 500)}, updated_at = now() WHERE id = ${jobId}`;
    throw e;
  }
  await sql`UPDATE jobs SET session_uri_enc = ${encrypt(container.id)}, updated_at = now() WHERE id = ${jobId}`;
  return { file: drive.name, ...(await continuePublish(userId, jobId)) };
}

export async function continuePublish(userId: string, jobId: string) {
  const started = Date.now();
  const sql = await db();
  const job = (await sql`SELECT * FROM jobs WHERE id = ${jobId} AND user_id = ${userId} AND kind = 'ig'`)[0];
  if (!job) throw new ToolError(`No Instagram job ${jobId}.`);
  if (job.status === "done") return reelSummary(job);
  if (job.status === "failed") throw new ToolError(`That Reel failed earlier: ${job.error}`);
  const { token, igId } = await igToken(userId);
  const containerId = decrypt(job.session_uri_enc);
  const auth = { authorization: `Bearer ${token}` };
  for (;;) {
    const st = await igJson(`${IG_GRAPH}/${containerId}?fields=status_code,status`, { headers: auth });
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      const error = `Instagram could not process the video (${st.status_code}${st.status ? `: ${st.status}` : ""}).`;
      await sql`UPDATE jobs SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${jobId}`;
      throw new ToolError(`${error} Check the Reel specs: MP4/MOV, H.264 or HEVC, AAC audio, 3 s to 15 min, 9:16, at most 300 MB.`);
    }
    if (st.status_code === "PUBLISHED") break;
    if (Date.now() - started + POLL_EVERY_MS > POLL_MS) {
      return { status: "in_progress", job_id: jobId, instagram_status: st.status_code, next: `Instagram is still processing the video. Wait a minute, then call instagram_continue_publish with job_id "${jobId}".` };
    }
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
  }
  const pub = await igJson<{ id: string; config_issue?: string }>(`${IG_GRAPH}/${igId}/media_publish`, {
    method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ creation_id: containerId }),
  });
  const notes: string[] = [];
  if (pub.config_issue) notes.push(`Instagram reported: ${pub.config_issue}`);
  let permalink: string | null = null;
  try { permalink = (await igJson(`${IG_GRAPH}/${pub.id}?fields=permalink`, { headers: auth })).permalink ?? null; } catch { /* optional */ }
  // Done with the files: stop serving them before cleaning up.
  await sql`UPDATE jobs SET status = 'done', video_id = ${pub.id}, uploaded = total, updated_at = now() WHERE id = ${jobId}`;
  if (job.extras?.delete_from_drive !== false) {
    const { deleteIfOurs } = await import("./tools.js");
    const dr = await accessToken(userId, "drive");
    notes.push(await deleteIfOurs(dr, job.drive_id));
    if (job.extras?.cover_drive_id) notes.push(await deleteIfOurs(dr, job.extras.cover_drive_id));
  }
  const extras = { ...job.extras, notes, permalink };
  await sql`UPDATE jobs SET extras = ${JSON.stringify(extras)} WHERE id = ${jobId}`;
  return reelSummary({ ...job, status: "done", video_id: pub.id, extras });
}

function reelSummary(job: Args) {
  return { status: "done", media_id: job.video_id, url: job.extras?.permalink ?? null, extras: job.extras?.notes ?? [] };
}

export async function listMedia(userId: string, max = 12) {
  const { token, igId } = await igToken(userId);
  const n = Math.min(50, Math.max(1, Number(max)));
  const r = await igJson<{ data: Args[] }>(`${IG_GRAPH}/${igId}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=${n}`, { headers: { authorization: `Bearer ${token}` } });
  return (r.data ?? []).map((m) => ({ media_id: m.id, type: m.media_product_type ?? m.media_type, caption: (m.caption ?? "").slice(0, 120), url: m.permalink, posted_at: m.timestamp }));
}

export async function publishingLimit(userId: string) {
  const { token, igId } = await igToken(userId);
  const r = unwrap(await igJson(`${IG_GRAPH}/${igId}/content_publishing_limit?fields=quota_usage,config`, { headers: { authorization: `Bearer ${token}` } }));
  return { used_last_24h: r.quota_usage ?? null, limit: r.config?.quota_total ?? null };
}
