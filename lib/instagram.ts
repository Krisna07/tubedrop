import { accessToken, gfetch, ToolError } from "./google.js";
import { db, encrypt, decrypt, randomId, safeEqual, sha256 } from "./util.js";

// Instagram API with Unified login (Business or Creator accounts, no Facebook Page). The owner generates
// an access token in the Meta App Dashboard and sets it as META_ACCESS_TOKEN; every call goes to
// graph.facebook.com with it. One token, one Instagram account: the owner's.
const IG_VERSION = process.env.IG_API_VERSION ?? "v26.0";
export const IG_GRAPH = `https://graph.facebook.com/${IG_VERSION}`;

export const instagramEnabled = () => !!process.env.META_ACCESS_TOKEN;

type Json = Record<string, any>;

async function igJson<T = Json>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${process.env.META_ACCESS_TOKEN}`);
  const r = await fetch(url, { ...init, headers });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok || body?.error) {
    const msg = body?.error?.message ?? (typeof body === "string" ? body.slice(0, 300) : r.status);
    if (body?.error?.code === 190) throw new ToolError(`The Instagram access token is no longer valid (${msg}). Generate a new one in the Meta App Dashboard and update META_ACCESS_TOKEN in Vercel.`);
    throw new ToolError(`Instagram API error ${r.status}: ${msg}`);
  }
  return body as T;
}

// ---------------------------------------------------------------- the account behind the token

let _account: { id: string; username: string | null } | null = null;

/** The Instagram account the token publishes to: META_IG_USER_ID if set, otherwise looked up once. */
export async function igAccount(): Promise<{ id: string; username: string | null }> {
  if (_account) return _account;
  if (process.env.META_IG_USER_ID) {
    const me = await igJson(`${IG_GRAPH}/${process.env.META_IG_USER_ID}?fields=id,username`).catch(() => ({} as Json));
    return (_account = { id: process.env.META_IG_USER_ID, username: me.username ?? null });
  }
  // A Unified login (system-user) token lists its accounts here.
  const assigned = await igJson<{ data?: Json[] }>(`${IG_GRAPH}/me/assigned_instagram_accounts?fields=id,username`).catch(() => null);
  let found = assigned?.data?.[0];
  // A Facebook user token reaches Instagram through the Pages it manages instead.
  if (!found) {
    const pages = await igJson<{ data?: Json[] }>(`${IG_GRAPH}/me/accounts?fields=instagram_business_account{id,username}`).catch(() => null);
    found = pages?.data?.map((p) => p.instagram_business_account).find(Boolean);
  }
  if (!found?.id) throw new ToolError("The access token does not reach any Instagram account. In the Meta App Dashboard, add your Instagram account under Generate access tokens and generate the token again, or set META_IG_USER_ID.");
  return (_account = { id: String(found.id), username: found.username ?? null });
}

/** When the token expires, if META_APP_ID and META_APP_SECRET are set to ask Meta. */
async function tokenExpiry(): Promise<string | null> {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) return null;
  try {
    const u = new URL(`${IG_GRAPH}/debug_token`);
    u.searchParams.set("input_token", process.env.META_ACCESS_TOKEN!);
    u.searchParams.set("access_token", `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`);
    const r = await fetch(u.toString());
    const d = ((await r.json()) as Json).data ?? {};
    if (!r.ok || d.is_valid === false) return "invalid";
    return d.expires_at ? new Date(d.expires_at * 1000).toISOString() : "never";
  } catch {
    return null;
  }
}

export async function whoamiInstagram() {
  const a = await igAccount();
  return { username: a.username, profile_url: a.username ? `https://www.instagram.com/${a.username}/` : null, token_expires: await tokenExpiry() };
}

// ---------------------------------------------------------------- media route (Meta fetches the video from here)

/**
 * Meta publishes from a public URL, so the Drive file is streamed through this route.
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
  const ig = await igAccount();
  const sql = await db();
  const jobId = "ig_" + randomId(9);
  const secret = randomId(24);
  const extras = { cover_drive_id: cover?.id, cover_mime: cover?.mimeType, delete_from_drive: a.delete_from_drive !== false };
  await sql`INSERT INTO jobs (id, user_id, drive_id, total, uploaded, mime, meta, extras, status, kind)
            VALUES (${jobId}, ${userId}, ${drive.id}, ${Number(drive.size ?? 0)}, 0, ${drive.mimeType},
                    ${JSON.stringify({ name: drive.name, ig_user_id: ig.id, media_secret_hash: sha256(secret) })}, ${JSON.stringify(extras)}, 'processing', 'ig')`;
  const media = (which: string) => `${base}/ig/media/${jobId}/${which}?t=${secret}`;
  const body: Args = { media_type: "REELS", video_url: media("video"), caption, share_to_feed: a.share_to_feed !== false };
  if (cover) body.cover_url = media("cover");
  else if (a.thumb_offset_ms !== undefined) body.thumb_offset = Number(a.thumb_offset_ms);
  if (a.is_ai_generated !== undefined) body.is_ai_generated = !!a.is_ai_generated;
  if (Array.isArray(a.collaborators) && a.collaborators.length) body.collaborators = a.collaborators.slice(0, 3);
  let container: { id: string };
  try {
    container = await igJson(`${IG_GRAPH}/${ig.id}/media`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
  const containerId = decrypt(job.session_uri_enc);
  for (;;) {
    const st = await igJson(`${IG_GRAPH}/${containerId}?fields=status_code,status`);
    if (st.status_code === "FINISHED" || st.status_code === "PUBLISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      const error = `Instagram could not process the video (${st.status_code}${st.status ? `: ${st.status}` : ""}).`;
      await sql`UPDATE jobs SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${jobId}`;
      throw new ToolError(`${error} Check the Reel specs: MP4/MOV, H.264 or HEVC, AAC audio, 3 s to 15 min, 9:16, at most 300 MB.`);
    }
    if (Date.now() - started + POLL_EVERY_MS > POLL_MS) {
      return { status: "in_progress", job_id: jobId, instagram_status: st.status_code, next: `Instagram is still processing the video. Wait a minute, then call instagram_continue_publish with job_id "${jobId}".` };
    }
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
  }
  const pub = await igJson<{ id: string; config_issue?: string }>(`${IG_GRAPH}/${job.meta.ig_user_id}/media_publish`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ creation_id: containerId }),
  });
  const notes: string[] = [];
  if (pub.config_issue) notes.push(`Instagram reported: ${pub.config_issue}`);
  let permalink: string | null = null;
  try { permalink = (await igJson(`${IG_GRAPH}/${pub.id}?fields=permalink`)).permalink ?? null; } catch { /* optional */ }
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

export async function listMedia(max = 12) {
  const ig = await igAccount();
  const n = Math.min(50, Math.max(1, Number(max)));
  const r = await igJson<{ data: Args[] }>(`${IG_GRAPH}/${ig.id}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=${n}`);
  return (r.data ?? []).map((m) => ({ media_id: m.id, type: m.media_product_type ?? m.media_type, caption: (m.caption ?? "").slice(0, 120), url: m.permalink, posted_at: m.timestamp }));
}

export async function publishingLimit() {
  const ig = await igAccount();
  const r = await igJson<{ data?: Json[] }>(`${IG_GRAPH}/${ig.id}/content_publishing_limit?fields=quota_usage,config`);
  const d = r.data?.[0] ?? {};
  return { used_last_24h: d.quota_usage ?? null, limit: d.config?.quota_total ?? null };
}
