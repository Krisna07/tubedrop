/**
 * End-to-end test of the uploader MCP against a fake Google (Drive + YouTube) and an in-process Postgres.
 * Exercises the real HTTP handler, OAuth bearer check, JSON-RPC, the tools, the Drive->YouTube pump,
 * Drive cleanup, and scripts/upload.sh (real curl, chunked, with an injected failure).
 *
 *   npm install && npm test
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uploader-e2e-"));
fs.mkdirSync(TMP, { recursive: true });

process.env.ENC_KEY = randomBytes(32).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.PUBLIC_URL = "https://uploader.test";
process.env.IG_POLL_SECONDS = "0";                  // one Instagram status check per call
delete process.env.INSTAGRAM_APP_ID;                 // Instagram is switched on later in the test

// ------------------------------------------------------------------ in-process Postgres behind the neon() interface
const pg = new PGlite();
(globalThis as any).__uploaderSql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  let text = "";
  strings.forEach((s, i) => { text += s + (i < values.length ? `$${i + 1}` : ""); });
  const r = await pg.query(text, values as any[]);
  return r.rows as Record<string, any>[];
};

// ------------------------------------------------------------------ fake Google
type DFile = { id: string; name: string; mimeType: string; parents: string[]; data: Buffer; appProperties?: Record<string, string> };
type Session = { kind: string; meta: any; total: number; got: Buffer[]; received: number; done?: any; url: string };
const drive = new Map<string, DFile>();
const videos = new Map<string, { id: string; snippet: any; status: any; data: Buffer }>();
const thumbs = new Map<string, Buffer>();
const captions: { videoId: string; data: Buffer; snippet: any }[] = [];
const sessions = new Map<string, Session>();
const log: string[] = [];
let failNextSessionPut = 0;
let PORT = 0;
const id = (p: string) => p + randomBytes(6).toString("hex");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

function body(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((res) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });
}
function send(res: http.ServerResponse, code: number, obj?: any, headers: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(obj === undefined ? "" : JSON.stringify(obj));
}
function newSession(kind: string, meta: any, total: number) {
  const sid = id("s_");
  const url = `http://127.0.0.1:${PORT}/session/${sid}`;
  sessions.set(sid, { kind, meta, total, got: [], received: 0, url });
  return url;
}
function complete(s: Session) {
  const data = Buffer.concat(s.got);
  if (s.kind === "drive") {
    const f: DFile = { id: id("d_"), name: s.meta.name, mimeType: s.meta.mimeType, parents: s.meta.parents ?? ["root"], data };
    drive.set(f.id, f);
    return { id: f.id, name: f.name, mimeType: f.mimeType, size: String(data.length) };
  }
  if (s.kind === "video") {
    const v = { id: id("v_"), snippet: s.meta.snippet, status: { ...s.meta.status, uploadStatus: "uploaded" }, data };
    videos.set(v.id, v);
    return { id: v.id, snippet: v.snippet, status: v.status };
  }
  if (s.kind === "thumbnail") { thumbs.set(s.meta.videoId, data); return { items: [{ default: {} }] }; }
  if (s.kind === "captions") { captions.push({ videoId: s.meta.snippet.videoId, data, snippet: s.meta.snippet }); return { id: id("c_") }; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url!, "http://x");
  const p = u.pathname;
  const auth = req.headers.authorization ?? "";
  const b = await body(req);
  log.push(`${req.method} ${p}${u.search.slice(0, 80)}`);
  // resumable session PUTs (no auth header, like Google)
  if (p.startsWith("/session/")) {
    const s = sessions.get(p.split("/")[2]);
    if (!s) return send(res, 404, { error: "no session" });
    if (s.done) return send(res, 200, s.done);
    const cr = String(req.headers["content-range"] ?? "");
    const probe = /^bytes \*\/(\d+)$/.exec(cr);
    const rangeHdr = (): Record<string, string> => (s.received ? { range: `bytes=0-${s.received - 1}` } : {});
    if (probe) return send(res, 308, undefined, rangeHdr());
    if (failNextSessionPut > 0) { failNextSessionPut--; return send(res, 503, { error: "backend error (injected)" }); }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    const start = m ? Number(m[1]) : 0;
    if (start !== s.received) return send(res, 308, undefined, rangeHdr());   // out of order: tell the client where we are
    s.got.push(b); s.received += b.length;
    if (s.received >= s.total) { s.done = complete(s); return send(res, 200, s.done); }
    return send(res, 308, undefined, rangeHdr());
  }
  if (!auth.startsWith("Bearer ")) return send(res, 401, { error: { message: "no auth" } });
  // ---- uploads
  if (p === "/upload/drive/v3/files" && u.searchParams.get("uploadType") === "resumable") {
    const meta = JSON.parse(b.toString());
    return send(res, 200, {}, { location: newSession("drive", { ...meta, mimeType: req.headers["x-upload-content-type"] }, Number(req.headers["x-upload-content-length"])) });
  }
  if (p === "/upload/youtube/v3/videos") {
    return send(res, 200, {}, { location: newSession("video", JSON.parse(b.toString()), Number(req.headers["x-upload-content-length"])) });
  }
  if (p === "/upload/youtube/v3/thumbnails/set") {
    const vid = u.searchParams.get("videoId")!;
    if (u.searchParams.get("uploadType") === "resumable")
      return send(res, 200, {}, { location: newSession("thumbnail", { videoId: vid }, Number(req.headers["x-upload-content-length"])) });
    thumbs.set(vid, b); return send(res, 200, { items: [{}] });
  }
  if (p === "/upload/youtube/v3/captions") {
    if (u.searchParams.get("uploadType") === "resumable")
      return send(res, 200, {}, { location: newSession("captions", JSON.parse(b.toString()), Number(req.headers["x-upload-content-length"])) });
    const text = b.toString("latin1");
    const meta = JSON.parse(text.slice(text.indexOf("{"), text.indexOf("}}") + 2));
    const dataStart = text.indexOf("\r\n\r\n", text.indexOf("octet-stream")) + 4;
    const dataEnd = text.lastIndexOf("\r\n--");
    captions.push({ videoId: meta.snippet.videoId, data: b.subarray(dataStart, dataEnd), snippet: meta.snippet });
    return send(res, 200, { id: id("c_") });
  }
  // ---- Drive
  if (p === "/drive/v3/files" && req.method === "GET") {
    const q = u.searchParams.get("q") ?? "";
    let files = [...drive.values()];
    if (q.includes("appProperties has")) files = files.filter((f) => f.appProperties?.tubedrop === "uploads" || (q.includes("dubiousArchive") && f.appProperties?.dubiousArchive === "uploads"));
    return send(res, 200, { files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })) });
  }
  if (p === "/drive/v3/files" && req.method === "POST") {
    const meta = JSON.parse(b.toString());
    const f: DFile = { id: id("fold_"), name: meta.name, mimeType: meta.mimeType, parents: ["root"], data: Buffer.alloc(0), appProperties: meta.appProperties };
    drive.set(f.id, f); return send(res, 200, { id: f.id });
  }
  const dm = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (dm) {
    const f = drive.get(dm[1]);
    if (!f) return send(res, 404, { error: { message: "File not found" } });
    if (req.method === "DELETE") { drive.delete(f.id); return send(res, 204); }
    if (u.searchParams.get("alt") === "media") {
      const r = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ""));
      const chunk = r ? f.data.subarray(Number(r[1]), Number(r[2]) + 1) : f.data;
      res.writeHead(r ? 206 : 200, { "content-type": f.mimeType }); return res.end(chunk);
    }
    return send(res, 200, { id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.data.length), parents: f.parents });
  }
  // ---- YouTube data API
  if (p === "/youtube/v3/videos" && req.method === "GET") {
    const v = videos.get(u.searchParams.get("id") ?? "");
    return send(res, 200, { items: v ? [{ id: v.id, snippet: v.snippet, status: v.status }] : [] });
  }
  if (p === "/youtube/v3/videos" && req.method === "PUT") {
    const upd = JSON.parse(b.toString());
    const v = videos.get(upd.id)!;
    if (upd.status?.publishAt && upd.status?.privacyStatus !== "private")
      return send(res, 400, { error: { message: "A video can only be scheduled while private", errors: [{ reason: "invalidPublishAt" }] } });
    v.snippet = upd.snippet; v.status = upd.status;
    return send(res, 200, { id: v.id, snippet: v.snippet, status: v.status });
  }
  return send(res, 404, { error: { message: `fake google: no route ${req.method} ${p}` } });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
PORT = (server.address() as any).port;

// ------------------------------------------------------------------ fake Meta (Instagram API with Instagram Login)
const IG_ID = "17840000000000001";
type Container = { body: any; video: Buffer; cover?: Buffer; polls: number };
const igContainers = new Map<string, Container>();
const igPosts: { id: string; caption: string; permalink: string }[] = [];
let igRefreshes = 0;
let serverGET: (r: Request) => Promise<Response>;
const igReply = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
async function fakeMeta(url: string, init: any = {}): Promise<Response> {
  const u = new URL(url);
  const method = init.method ?? "GET";
  const bearer = new Headers(init.headers).get("authorization") ?? "";
  if (u.host === "api.instagram.com" && u.pathname === "/oauth/access_token") {
    const f = new URLSearchParams(String(init.body));
    if (f.get("code") !== "good-code" || f.get("client_secret") !== "ig-secret") return igReply({ error_type: "OAuthException", code: 400, error_message: "Matching code was not found" }, 400);
    return igReply({ data: [{ access_token: "ig-short", user_id: IG_ID, permissions: "instagram_business_basic,instagram_business_content_publish" }] });
  }
  if (u.pathname === "/access_token") return igReply({ access_token: "ig-long-1", token_type: "bearer", expires_in: 5184000 });
  if (u.pathname === "/refresh_access_token") { igRefreshes++; return igReply({ access_token: "ig-long-2", token_type: "bearer", expires_in: 5184000 }); }
  if (!bearer.startsWith("Bearer ig-long")) return igReply({ error: { message: "Invalid OAuth access token" } }, 401);
  const p = u.pathname.replace(/^\/v[\d.]+/, "");
  if (p === "/me") return igReply({ data: [{ user_id: IG_ID, username: "dubious.archive" }] });
  if (p === `/${IG_ID}/media` && method === "POST") {
    const body = JSON.parse(init.body);
    const grab = async (src: string) => { const r = await serverGET(new Request(src)); if (r.status !== 200) throw new Error(`media fetch ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
    try {
      const c: Container = { body, video: await grab(body.video_url), cover: body.cover_url ? await grab(body.cover_url) : undefined, polls: 0 };
      const cid = id("cont_"); igContainers.set(cid, c); return igReply({ id: cid });
    } catch (e) { return igReply({ error: { message: `Media download failed: ${(e as Error).message}` } }, 400); }
  }
  if (p === `/${IG_ID}/media` && method === "GET") return igReply({ data: igPosts.map((m) => ({ id: m.id, caption: m.caption, media_type: "VIDEO", media_product_type: "REELS", permalink: m.permalink, timestamp: "2026-10-31T00:00:00+0000" })) });
  if (p === `/${IG_ID}/media_publish`) {
    const c = igContainers.get(JSON.parse(init.body).creation_id);
    if (!c || c.polls < 2) return igReply({ error: { message: "Media ID is not available" } }, 400);
    const post = { id: id("m_"), caption: c.body.caption, permalink: `https://www.instagram.com/reel/${randomBytes(4).toString("hex")}/` };
    igPosts.push(post); return igReply({ id: post.id });
  }
  if (p === `/${IG_ID}/content_publishing_limit`) return igReply({ data: [{ quota_usage: igPosts.length, config: { quota_total: 50, quota_duration: 86400 } }] });
  const c = igContainers.get(p.slice(1));
  if (c) { c.polls++; return igReply({ id: p.slice(1), status_code: c.polls >= 2 ? "FINISHED" : "IN_PROGRESS" }); }
  const post = igPosts.find((m) => m.id === p.slice(1));
  if (post) return igReply({ id: post.id, permalink: post.permalink });
  return igReply({ error: { message: `fake meta: no route ${method} ${p}` } }, 404);
}

// Route the server's Google and Meta calls to the fakes.
const realFetch = globalThis.fetch;
globalThis.fetch = (input: any, init?: any) => {
  let url = typeof input === "string" ? input : input.url;
  if (/^https:\/\/(graph|api)\.instagram\.com\//.test(url)) return fakeMeta(url, init);
  url = url.replace("https://www.googleapis.com", `http://127.0.0.1:${PORT}`);
  if (url.startsWith("https://oauth2.googleapis.com")) return Promise.resolve(new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 }));
  return realFetch(url, init);
};

// ------------------------------------------------------------------ the server under test
const { POST, GET } = await import(pathToFileURL(`${ROOT}/api/index.ts`).href);
const { db, encrypt, sha256 } = await import(pathToFileURL(`${ROOT}/lib/util.ts`).href);
serverGET = GET;
const sql = await db();
const exp = new Date(Date.now() + 3600e3).toISOString();
await sql`INSERT INTO users (id, email, channel_id, channel_title, google_refresh_enc, google_access_enc, google_expiry, yt_refresh_enc, yt_access_enc, yt_expiry)
          VALUES ('u1', 'me@example.com', 'UC1', 'Test Channel', ${encrypt("r1")}, ${encrypt("drive-token")}, ${exp}, ${encrypt("r2")}, ${encrypt("yt-token")}, ${exp})`;
await sql`INSERT INTO tokens (token_hash, kind, user_id, client_id, expires_at) VALUES (${sha256("at_test")}, 'access', 'u1', 'c1', ${exp})`;

let rpcId = 0;
async function call(name: string, args: any = {}, token = "at_test") {
  const r: Response = await POST(new Request("https://uploader.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  }));
  if (r.status !== 200) return { httpStatus: r.status };
  const j = await r.json();
  const text = j.result.content[0].text;
  if (j.result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}
async function uploadSh(url: string, file: string, type: string) {
  const { stdout } = await execFileP("bash", [`${ROOT}/scripts/upload.sh`, url, file, type], { maxBuffer: 1 << 24 });
  return JSON.parse(stdout);
}

const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, info = "") => { results.push([name, ok, info]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); };

// ------------------------------------------------------------------ 0. auth and tool list
{
  const r: Response = await POST(new Request("https://uploader.test/mcp", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  check("no token -> 401 with resource metadata", r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes("oauth-protected-resource"));
  const r2: Response = await POST(new Request("https://uploader.test/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer at_test" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }));
  const names = (await r2.json()).result.tools.map((t: any) => t.name);
  check("tools/list includes get_upload_url and upload_video", names.includes("get_upload_url") && names.includes("upload_video"), names.join(","));
  check("no Instagram tools without INSTAGRAM_APP_ID", !names.some((n: string) => n.startsWith("instagram_")));
}

// ------------------------------------------------------------------ 1. local files -> Drive (direct, via upload.sh)
// An uploads folder made before the TubeDrop rename must keep working.
drive.set("fold_legacy", { id: "fold_legacy", name: "The Dubious Archive - Uploads", mimeType: "application/vnd.google-apps.folder", parents: ["root"], data: Buffer.alloc(0), appProperties: { dubiousArchive: "uploads" } });
const vidPath = path.join(TMP, "film.mp4"); const vid = randomBytes(150 * 1024 * 1024 + 12345); fs.writeFileSync(vidPath, vid);
const thPath = path.join(TMP, "thumb.jpg"); const th = randomBytes(180 * 1024); fs.writeFileSync(thPath, th);
const srtPath = path.join(TMP, "film.srt"); fs.writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:02,000\nHello.\n\n");

const toDrive = async (file: string, type: string) => {
  const g = await call("get_upload_url", { kind: "drive", size_bytes: fs.statSync(file).size, file_name: path.basename(file), mime: type });
  failNextSessionPut = file === vidPath ? 1 : 0;                 // drop one chunk of the big file to test resume
  return await uploadSh(g.upload_url, file, type);
};
const dVid = await toDrive(vidPath, "video/mp4");
const dTh = await toDrive(thPath, "image/jpeg");
const dSrt = await toDrive(srtPath, "application/octet-stream");
check("video reached Drive intact (3 chunks, one injected 503 + resume)", sha(drive.get(dVid.id)!.data) === sha(vid), `${(vid.length / 1048576).toFixed(1)} MB`);
check("thumbnail and captions reached Drive", !!drive.get(dTh.id) && !!drive.get(dSrt.id));
const folder = [...drive.values()].find((f) => f.appProperties?.tubedrop === "uploads" || f.appProperties?.dubiousArchive === "uploads");
check("existing (pre-rename) uploads folder is reused", folder?.id === "fold_legacy" && [...drive.values()].filter((f) => f.mimeType.includes("folder")).length === 1);
check("files sit in the connector's uploads folder", !!folder && drive.get(dVid.id)!.parents.includes(folder!.id));

// ------------------------------------------------------------------ 2. Drive -> YouTube, then Drive cleanup
let up = await call("upload_video", {
  drive_file: dVid.id, title: "Test film", description: "0:00 Start", tags: ["a"], category_id: "27",
  privacy: "private", publish_at: "2026-10-29T12:00:00+11:00", default_audio_language: "en-GB",
  thumbnail_drive_file: dTh.id, captions_drive_file: dSrt.id,
});
let calls = 1;
while (up.status === "in_progress") { up = await call("continue_upload", { job_id: up.job_id }); calls++; }
const v = videos.get(up.video_id);
check("video reached YouTube intact", !!v && sha(v.data) === sha(vid), `${calls} call(s)`);
check("scheduled as private with publishAt", v?.status.privacyStatus === "private" && v?.status.publishAt === "2026-10-29T01:00:00.000Z", JSON.stringify(v?.status));
check("thumbnail set from Drive", !!thumbs.get(up.video_id) && sha(thumbs.get(up.video_id)!) === sha(th));
check("captions added from Drive", captions.some((c) => c.videoId === up.video_id && c.data.toString().includes("Hello.")));
check("video, thumbnail and captions deleted from Drive", !drive.has(dVid.id) && !drive.has(dTh.id) && !drive.has(dSrt.id), up.extras.join(" | "));
check("uploads folder itself kept", drive.has(folder!.id));

// ------------------------------------------------------------------ 3. never delete files outside the uploads folder
const own: DFile = { id: id("d_"), name: "my-own.mp4", mimeType: "video/mp4", parents: ["root"], data: randomBytes(2 * 1024 * 1024) };
drive.set(own.id, own);
let up2 = await call("upload_video", { drive_file: own.id, title: "Own file" });
while (up2.status === "in_progress") up2 = await call("continue_upload", { job_id: up2.job_id });
check("file outside uploads folder is kept", drive.has(own.id), up2.extras.join(" | "));
check("default privacy is private", videos.get(up2.video_id)?.status.privacyStatus === "private");

// ------------------------------------------------------------------ 4. delete_from_drive: false keeps the file
const keepG = await call("get_upload_url", { kind: "drive", size_bytes: own.data.length, file_name: "keep.mp4", mime: "video/mp4" });
const keepPath = path.join(TMP, "keep.mp4"); fs.writeFileSync(keepPath, own.data);
const dKeep = await uploadSh(keepG.upload_url, keepPath, "video/mp4");
let up3 = await call("upload_video", { drive_file: dKeep.id, title: "Keep", delete_from_drive: false });
while (up3.status === "in_progress") up3 = await call("continue_upload", { job_id: up3.job_id });
check("delete_from_drive:false keeps the Drive file", drive.has(dKeep.id));

// ------------------------------------------------------------------ 5. publish a scheduled video now
const pub = await call("update_video", { video_id: up.video_id, privacy: "public" });
check("scheduled video can be made public now (schedule cleared)", pub.privacy === "public" && pub.publish_at === null, JSON.stringify(pub));

// ------------------------------------------------------------------ 6. direct to YouTube (no Drive) + thumbnail
const gv = await call("get_upload_url", { kind: "video", size_bytes: own.data.length, file_name: "direct.mp4", title: "Direct", privacy: "private" });
const direct = await uploadSh(gv.upload_url, keepPath, "video/mp4");
check("direct video upload creates a private video", videos.get(direct.id)?.status.privacyStatus === "private");
const gt = await call("get_upload_url", { kind: "thumbnail", size_bytes: th.length, file_name: "thumb.jpg", video_id: direct.id });
await uploadSh(gt.upload_url, thPath, "image/jpeg");
check("direct thumbnail upload", sha(thumbs.get(direct.id)!) === sha(th));

// ------------------------------------------------------------------ 7. input validation
let refused = false;
try { await call("get_upload_url", { kind: "thumbnail", size_bytes: 3 * 1024 * 1024, video_id: direct.id }); } catch { refused = true; }
check("oversized thumbnail refused before upload", refused);

// ------------------------------------------------------------------ 8. Instagram: link the account
process.env.INSTAGRAM_APP_ID = "ig-app";
process.env.INSTAGRAM_APP_SECRET = "ig-secret";
const refusedCall = async (name: string, args: any) => { try { await call(name, args); return ""; } catch (e) { return (e as Error).message; } };
{
  const r2: Response = await POST(new Request("https://uploader.test/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer at_test" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }) }));
  const names = (await r2.json()).result.tools.map((t: any) => t.name);
  check("Instagram tools listed once INSTAGRAM_APP_ID is set", ["instagram_connect", "instagram_publish_reel", "instagram_continue_publish", "instagram_list_media"].every((n) => names.includes(n)));
}
check("whoami shows no Instagram account before linking", (await call("whoami")).instagram === null);
const conn = await call("instagram_connect");
const start: Response = await GET(new Request(conn.link));
const authUrl = new URL(start.headers.get("location") ?? "https://x/");
check("connect link redirects to Instagram sign-in with publish scope",
  start.status === 302 && authUrl.host === "www.instagram.com" && authUrl.searchParams.get("scope")!.includes("instagram_business_content_publish") &&
  authUrl.searchParams.get("redirect_uri") === "https://uploader.test/instagram/callback");
const cb: Response = await GET(new Request(`https://uploader.test/instagram/callback?code=good-code&state=${authUrl.searchParams.get("state")}`));
check("Instagram callback stores the account", cb.status === 200 && (await call("whoami")).instagram?.username === "dubious.archive");
const again: Response = await GET(new Request(`https://uploader.test/instagram/callback?code=good-code&state=${authUrl.searchParams.get("state")}`));
check("connect link only works once", again.status === 400);
const stored = (await sql`SELECT token_enc FROM instagram_accounts WHERE user_id = 'u1'`)[0];
check("Instagram token is stored encrypted", !!stored && !String(stored.token_enc).includes("ig-long"));

// ------------------------------------------------------------------ 9. Instagram: publish a Reel from Drive
const reelPath = path.join(TMP, "reel.mp4"); const reel = randomBytes(3 * 1024 * 1024 + 77); fs.writeFileSync(reelPath, reel);
const coverPath = path.join(TMP, "cover.jpg"); const cov = randomBytes(90 * 1024); fs.writeFileSync(coverPath, cov);
const dReel = await toDrive(reelPath, "video/mp4");
const dCover = await toDrive(coverPath, "image/jpeg");
check("publishing without user_confirmed is refused", (await refusedCall("instagram_publish_reel", { drive_file: dReel.id, caption: "x" })).includes("user_confirmed"));
check("caption over 2,200 characters is refused", (await refusedCall("instagram_publish_reel", { drive_file: dReel.id, caption: "a".repeat(2201), user_confirmed: true })).includes("2,200"));
check("an image is not accepted as the Reel video", (await refusedCall("instagram_publish_reel", { drive_file: dCover.id, user_confirmed: true })).includes("MP4 or MOV"));
let reelJob = await call("instagram_publish_reel", { drive_file: dReel.id, caption: "The night the sky fell #history", cover_drive_file: dCover.id, is_ai_generated: true, user_confirmed: true });
const container = [...igContainers.values()].at(-1)!;
check("Meta received the exact video bytes from the media route", !!container && sha(container.video) === sha(reel) && container.body.video_url.startsWith("https://uploader.test/ig/media/"));
check("Meta received the cover and Reel settings", !!container?.cover && sha(container.cover) === sha(cov) && container.body.media_type === "REELS" &&
  container.body.share_to_feed === true && container.body.is_ai_generated === true && container.body.caption.includes("#history"));
check("Reel waits while Instagram processes", reelJob.status === "in_progress", JSON.stringify(reelJob));
const badSecret: Response = await GET(new Request(container.body.video_url.replace(/t=[^&]+/, "t=wrong")));
check("media route refuses a wrong secret", badSecret.status === 404);
const ranged: Response = await GET(new Request(container.body.video_url, { headers: { range: "bytes=0-99" } }));
check("media route honours Range requests", ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 100);
check("continue_upload refuses an Instagram job", (await refusedCall("continue_upload", { job_id: reelJob.job_id })).includes("instagram_continue_publish"));
let igCalls = 1;
while (reelJob.status === "in_progress" && igCalls < 10) { reelJob = await call("instagram_continue_publish", { job_id: reelJob.job_id }); igCalls++; }
check("Reel published with a permalink", reelJob.status === "done" && igPosts.length === 1 && reelJob.url === igPosts[0].permalink, `${igCalls} call(s)`);
check("Reel video and cover deleted from Drive", !drive.has(dReel.id) && !drive.has(dCover.id), (reelJob.extras ?? []).join(" | "));
const afterDone: Response = await GET(new Request(container.body.video_url));
check("media route stops serving once published", afterDone.status === 404);

// ------------------------------------------------------------------ 10. Instagram: token refresh and listing
await sql`UPDATE instagram_accounts SET refreshed_at = now() - interval '2 days' WHERE user_id = 'u1'`;
const listed = await call("instagram_list_media");
check("token older than a day is refreshed", igRefreshes === 1);
check("list_media returns the Reel and the publishing limit", listed.items.length === 1 && listed.items[0].type === "REELS" && listed.publishing_limit?.limit === 50, JSON.stringify(listed.publishing_limit));
await call("instagram_list_media");
check("fresh token is not refreshed again", igRefreshes === 1);

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
server.close(); await pg.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
