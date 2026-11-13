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
delete process.env.META_ACCESS_TOKEN;                // Instagram is switched on later in the test

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
let analyticsMode: "ok" | "no-scope" | "disabled" = "ok";
let searchQuota: "ok" | "exceeded" = "ok";
const searchQueries: Record<string, string>[] = [];
const chartQueries: Record<string, string>[] = [];
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
// Other creators' videos that the platform-wide search and chart return.
const trendingVideos = [
  { id: "tr_new", title: "Small but brand new #shorts", channel: "Chan A", published: hoursAgo(2), views: 4000, dur: "PT30S" },     // 2000 views/hour
  { id: "tr_big", title: "Huge but older #shorts", channel: "Chan B", published: hoursAgo(100), views: 50000, dur: "PT45S" },      // 500 views/hour
  { id: "tr_long", title: "Ten minute documentary", channel: "Chan C", published: hoursAgo(5), views: 90000, dur: "PT10M" },       // not a Short
  { id: "tr_stale", title: "Viral last month #shorts", channel: "Chan D", published: hoursAgo(24 * 12), views: 900000, dur: "PT20S" }, // outside 7 days
];
const trendingItem = (t: (typeof trendingVideos)[number]) => ({
  id: t.id, snippet: { title: t.title, channelTitle: t.channel, channelId: "UC_" + t.channel, publishedAt: t.published },
  status: { privacyStatus: "public" }, statistics: { viewCount: String(t.views), likeCount: "10", commentCount: "2" }, contentDetails: { duration: t.dur },
});
const analyticsQueries: Record<string, string>[] = [];
const commentQueries: Record<string, string>[] = [];
const postedReplies: any[] = [];
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

const ytAuth: string[] = [];   // the access token on every YouTube call, in order
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url!, "http://x");
  const p = u.pathname;
  const auth = req.headers.authorization ?? "";
  const b = await body(req);
  log.push(`${req.method} ${p}${u.search.slice(0, 200)}`);
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
  if (p.includes("/youtube/")) ytAuth.push(auth.slice(7));
  if (p === "/youtube/v3/channels" && u.searchParams.get("mine") === "true") return send(res, 200, { items: [{ id: "UC2", snippet: { title: "Second Channel" } }] });
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
  if (p === "/youtube/v3/search" && req.method === "GET") {
    searchQueries.push(Object.fromEntries(u.searchParams));
    if (searchQuota === "exceeded") return send(res, 403, { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } });
    return send(res, 200, { items: trendingVideos.map((t) => ({ id: { kind: "youtube#video", videoId: t.id }, snippet: { title: t.title } })) });
  }
  if (p === "/youtube/v3/videos" && req.method === "GET" && u.searchParams.get("chart") === "mostPopular") {
    chartQueries.push(Object.fromEntries(u.searchParams));
    return send(res, 200, { items: trendingVideos.map(trendingItem) });
  }
  if (p === "/youtube/v3/videos" && req.method === "GET" && (u.searchParams.get("id") ?? "").split(",").some((x) => x.startsWith("tr_"))) {
    return send(res, 200, { items: (u.searchParams.get("id") ?? "").split(",").map((x) => trendingVideos.find((t) => t.id === x)).filter(Boolean).map((t) => trendingItem(t!)) });
  }
  if (p === "/youtube/v3/videos" && req.method === "GET") {
    const found = (u.searchParams.get("id") ?? "").split(",").map((x) => videos.get(x)).filter(Boolean) as { id: string; snippet: any; status: any; data: Buffer }[];
    return send(res, 200, { items: found.map((v) => ({ id: v.id, snippet: { ...v.snippet, publishedAt: "2026-11-01T09:00:00Z" }, status: v.status,
      statistics: { viewCount: "1234", likeCount: "56", commentCount: "7" }, contentDetails: { duration: "PT58S" } })) });
  }
  // ---- YouTube Analytics API (host rewritten to /yta)
  if (p === "/yta/v2/reports") {
    analyticsQueries.push(Object.fromEntries(u.searchParams));
    if (analyticsMode === "no-scope") return send(res, 403, { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } });
    if (analyticsMode === "disabled") return send(res, 403, { error: { code: 403, message: "YouTube Analytics API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } });
    const dim = u.searchParams.get("dimensions");
    const metrics = (u.searchParams.get("metrics") ?? "").split(",");
    const vid = [...videos.keys()][0];
    const rows = dim === "video" ? [[vid, ...metrics.map((_, i) => 100 - i)]] : dim === "day" ? [["2026-11-01", ...metrics.map(() => 5)], ["2026-11-02", ...metrics.map(() => 9)]]
      : dim === "insightTrafficSourceType" ? [["SHORTS", 80, 12], ["YT_SEARCH", 20, 3]] : [[0.01, 1.0, 0.6], [0.5, 0.42, 0.55]];
    return send(res, 200, { kind: "youtubeAnalytics#resultTable", columnHeaders: [{ name: dim }, ...metrics.map((name) => ({ name }))], rows });
  }
  if (p === "/youtube/v3/videos" && req.method === "PUT") {
    const upd = JSON.parse(b.toString());
    const v = videos.get(upd.id)!;
    if (upd.status?.publishAt && upd.status?.privacyStatus !== "private")
      return send(res, 400, { error: { message: "A video can only be scheduled while private", errors: [{ reason: "invalidPublishAt" }] } });
    v.snippet = upd.snippet; v.status = upd.status;
    return send(res, 200, { id: v.id, snippet: v.snippet, status: v.status });
  }
  // ---- YouTube comments
  if (p === "/youtube/v3/commentThreads" && req.method === "GET") {
    commentQueries.push(Object.fromEntries(u.searchParams));
    return send(res, 200, { items: [
      { id: "t1", snippet: { videoId: "vA", totalReplyCount: 0, topLevelComment: { id: "c1", snippet: { authorDisplayName: "@fan", textDisplay: "Love this!", likeCount: 2, publishedAt: "2026-11-02T00:00:00Z", authorChannelId: { value: "UCfan" } } } } },
      { id: "t2", snippet: { videoId: "vB", totalReplyCount: 1, topLevelComment: { id: "c2", snippet: { authorDisplayName: "@q", textDisplay: "Is this real?", likeCount: 0, authorChannelId: { value: "UCq" } } } },
        replies: { comments: [{ snippet: { authorChannelId: { value: "UC1" }, textDisplay: "Yes!" } }] } },
    ] });
  }
  if (p === "/youtube/v3/comments" && req.method === "POST") {
    const bodyJ = JSON.parse(b.toString());
    postedReplies.push(bodyJ);
    return send(res, 200, { id: "r_" + postedReplies.length, snippet: bodyJ.snippet });
  }
  return send(res, 404, { error: { message: `fake google: no route ${req.method} ${p}` } });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
PORT = (server.address() as any).port;

// ------------------------------------------------------------------ fake Meta (Instagram API with Unified login, graph.facebook.com)
const IG_ID = "17840000000000001";
type Container = { body: any; video: Buffer; cover?: Buffer; polls: number };
const igContainers = new Map<string, Container>();
const igPosts: { id: string; caption: string; permalink: string }[] = [];
let serverGET: (r: Request) => Promise<Response>;
const igReply = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
async function fakeMeta(url: string, init: any = {}): Promise<Response> {
  const u = new URL(url);
  const method = init.method ?? "GET";
  const bearer = new Headers(init.headers).get("authorization") ?? "";
  const p = u.pathname.replace(/^\/v[\d.]+/, "");
  if (p === "/debug_token") {
    if (u.searchParams.get("access_token") !== "meta-app|meta-secret") return igReply({ error: { message: "Invalid app token" } }, 400);
    return igReply({ data: { is_valid: u.searchParams.get("input_token") === "meta-token", expires_at: 0 } });
  }
  if (bearer !== "Bearer meta-token") return igReply({ error: { message: "Invalid OAuth access token", code: 190 } }, 401);
  if (p === "/me/assigned_instagram_accounts") return igReply({ data: [{ id: IG_ID, username: "dubious.archive" }] });
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
  if (url.startsWith("https://graph.facebook.com/")) return fakeMeta(url, init);
  url = url.replace("https://www.googleapis.com", `http://127.0.0.1:${PORT}`);
  url = url.replace("https://youtubeanalytics.googleapis.com", `http://127.0.0.1:${PORT}/yta`);
  if (url.startsWith("https://oauth2.googleapis.com") && String(init?.body).includes("authorization_code"))
    return Promise.resolve(new Response(JSON.stringify({ access_token: "new-yt-access", refresh_token: "new-yt-refresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.force-ssl" }), { status: 200 }));
  if (url.startsWith("https://oauth2.googleapis.com")) return Promise.resolve(new Response(JSON.stringify({ access_token: "fresh:" + new URLSearchParams(String(init?.body)).get("refresh_token"), expires_in: 3600 }), { status: 200 }));
  return realFetch(url, init);
};

// ------------------------------------------------------------------ the server under test
const { POST, GET } = await import(pathToFileURL(`${ROOT}/api/index.ts`).href);
const { db, decrypt, encrypt, sha256 } = await import(pathToFileURL(`${ROOT}/lib/util.ts`).href);
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
  check("no Instagram tools without META_ACCESS_TOKEN",!names.some((n: string) => n.startsWith("instagram_")));
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

// ------------------------------------------------------------------ 8. Instagram: switch on with a token
const refusedCall = async (name: string, args: any) => { try { await call(name, args); return ""; } catch (e) { return (e as Error).message; } };
check("Instagram tools refuse to run without META_ACCESS_TOKEN", (await refusedCall("instagram_list_media", {})).includes("META_ACCESS_TOKEN"));
process.env.META_ACCESS_TOKEN = "meta-token";
process.env.META_APP_ID = "meta-app";
process.env.META_APP_SECRET = "meta-secret";
{
  const r2: Response = await POST(new Request("https://uploader.test/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer at_test" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }) }));
  const names = (await r2.json()).result.tools.map((t: any) => t.name);
  check("Instagram tools listed once META_ACCESS_TOKEN is set", ["instagram_publish_reel", "instagram_continue_publish", "instagram_list_media"].every((n) => names.includes(n)));
}
const who = await call("whoami");
check("whoami finds the Instagram account and token expiry", who.instagram?.username === "dubious.archive" && who.instagram?.token_expires === "never", JSON.stringify(who.instagram));

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

// ------------------------------------------------------------------ 10. Instagram: listing and a revoked token
const listed = await call("instagram_list_media");
check("list_media returns the Reel and the publishing limit", listed.items.length === 1 && listed.items[0].type === "REELS" && listed.publishing_limit?.limit === 50, JSON.stringify(listed.publishing_limit));
process.env.META_ACCESS_TOKEN = "revoked-token";
check("a revoked token gives a clear fix", (await refusedCall("instagram_list_media", {})).includes("update META_ACCESS_TOKEN"));

// ------------------------------------------------------------------ 11. Video stats and YouTube Analytics
const someVid = [...videos.keys()][0];
const stats = await call("get_video_stats", { video_ids: [someVid, "missing"] });
check("get_video_stats returns views, likes, comments and Short detection", stats.length === 1 && stats[0].views === 1234 && stats[0].likes === 56 &&
  stats[0].comments === 7 && stats[0].duration_seconds === 58 && stats[0].is_short === true, JSON.stringify(stats));
check("get_video_stats refuses more than 50 ids", (await refusedCall("get_video_stats", { video_ids: Array.from({ length: 51 }, (_, i) => "v" + i) })).includes("50"));
const top = await call("get_analytics", { report: "videos", start_date: "2026-10-01", end_date: "2026-11-02" });
const q1 = analyticsQueries.at(-1)!;
check("videos report asks for the channel's own data in the right range", q1.ids === "channel==MINE" && q1.startDate === "2026-10-01" && q1.endDate === "2026-11-02" && q1.dimensions === "video");
check("videos report rows carry title, Short flag and metrics", top.rows.length === 1 && top.rows[0].video_id === someVid && top.rows[0].is_short === true &&
  top.rows[0].views === 100 && "average_view_percentage" in top.rows[0] && "subscribers_gained" in top.rows[0], JSON.stringify(top.rows[0]));
const daily = await call("get_analytics", { report: "daily", video_id: someVid });
check("daily report defaults to the last 28 days and filters by video", daily.rows.length === 2 && analyticsQueries.at(-1)!.filters === `video==${someVid}` &&
  (new Date(daily.end_date).getTime() - new Date(daily.start_date).getTime()) === 28 * 86400e3);
const traffic = await call("get_analytics", { report: "traffic_sources" });
check("traffic_sources report lists sources", traffic.rows[0].insight_traffic_source_type === "SHORTS" && traffic.rows[0].views === 80);
check("retention needs a video_id", (await refusedCall("get_analytics", { report: "retention" })).includes("video_id"));
const ret = await call("get_analytics", { report: "retention", video_id: someVid });
check("retention report returns the curve", ret.rows.length === 2 && ret.rows[1].audience_watch_ratio === 0.42);
check("bad dates are refused", (await refusedCall("get_analytics", { start_date: "last week" })).includes("2026-10-01"));
analyticsMode = "no-scope";
check("missing analytics permission says to reconnect", (await refusedCall("get_analytics", {})).includes("reconnect TubeDrop"));
analyticsMode = "disabled";
check("disabled Analytics API says to enable it", (await refusedCall("get_analytics", {})).includes("Enable \"YouTube Analytics API\""));
analyticsMode = "ok";

// ------------------------------------------------------------------ 12. Comments
const allC = await call("list_comments", {});
check("list_comments reads the channel's threads", commentQueries.at(-1)!.allThreadsRelatedToChannelId === "UC1" && allC.length === 2 && allC[0].text === "Love this!");
check("list_comments marks threads the channel already answered", allC[1].channel_replied === true && allC[0].channel_replied === false);
const openC = await call("list_comments", { unanswered_only: true, video_id: "vA" });
check("unanswered_only filters and video_id narrows", openC.length === 1 && commentQueries.at(-1)!.videoId === "vA");
check("reply needs user_confirmed", (await refusedCall("reply_to_comment", { comment_id: "c1", text: "Thanks!" })).includes("user_confirmed"));
const rep = await call("reply_to_comment", { comment_id: "c1", text: "Thanks for watching!", user_confirmed: true });
check("reply posts under the parent comment", rep.reply_id === "r_1" && postedReplies[0].snippet.parentId === "c1" && postedReplies[0].snippet.textOriginal === "Thanks for watching!");

// ------------------------------------------------------------------ 13. Platform-wide trending
const trend = await call("find_trending", { query: "couple argument", category_id: "23", region_code: "au" });
const sq = searchQueries.at(-1)!;
check("find_trending searches recent videos by view count, Shorts only", sq.type === "video" && sq.order === "viewCount" && sq.videoDuration === "short" &&
  sq.q === "couple argument" && sq.videoCategoryId === "23" && sq.regionCode === "AU", JSON.stringify(sq));
check("find_trending looks back 7 days by default", Math.abs(Date.now() - new Date(sq.publishedAfter).getTime() - 7 * 86400e3) < 60e3);
check("find_trending ranks by views per hour, not total views", trend.items[0]?.video_id === "tr_new" && trend.items[1]?.video_id === "tr_big" &&
  trend.items[0].views_per_hour > trend.items[1].views_per_hour, trend.items.map((i: any) => `${i.video_id}:${i.views_per_hour}`).join(" "));
check("find_trending drops non-Shorts and videos outside the window", trend.items.length === 2, trend.items.map((i: any) => i.video_id).join(","));
check("find_trending items carry channel, link and Short flag", trend.items[0].channel === "Chan A" && trend.items[0].url === "https://youtu.be/tr_new" && trend.items[0].is_short === true);
check("find_trending reports the quota it used", trend.quota_cost === 101);
const longToo = await call("find_trending", { shorts_only: false, published_within_days: 30 });
check("shorts_only:false keeps long videos; a 30-day window keeps older ones", longToo.items.length === 4 && "videoDuration" in searchQueries.at(-1)! === false, longToo.items.map((i: any) => i.video_id).join(","));
const capped = await call("find_trending", { max: 1 });
check("max limits the number returned", capped.items.length === 1);
const pop = await call("find_trending", { mode: "popular" });
check("popular mode reads the most-popular chart for the US by default for 1 unit", chartQueries.at(-1)!.chart === "mostPopular" && chartQueries.at(-1)!.regionCode === "US" &&
  pop.quota_cost === 1 && pop.items[0].video_id === "tr_new" && pop.items.length === 2, JSON.stringify(chartQueries.at(-1)));
check("find_trending refuses a bad region code", (await refusedCall("find_trending", { region_code: "Australia" })).includes("two-letter"));
check("find_trending refuses an unknown mode", (await refusedCall("find_trending", { mode: "hot" })).includes("mode"));
searchQuota = "exceeded";
check("exhausted quota gives a clear message and points to popular mode", (await refusedCall("find_trending", {})).includes("popular"));
searchQuota = "ok";

// ------------------------------------------------------------------ 14. Multiple channels
const ch0 = await call("list_channels");
check("existing single-channel users are migrated into the channels table", ch0.channels.length === 1 && ch0.channels[0].channel_id === "UC1" && ch0.channels[0].active === true, JSON.stringify(ch0));
const added = await call("add_channel");
const addUrl = new URL(added.sign_in_url);
check("add_channel returns a Google sign-in URL asking for YouTube access", addUrl.hostname === "accounts.google.com" && addUrl.searchParams.get("scope")!.includes("youtube.force-ssl"), added.sign_in_url);
const cb = await GET(new Request(`https://uploader.test/google/callback?code=abc&state=${addUrl.searchParams.get("state")}`));
check("the add-channel callback links the channel without touching the OAuth flow", cb.status === 200 && (await cb.text()).includes("Channel added"), String(cb.status));
const ch1 = await call("list_channels");
check("the new channel is listed and the active one is unchanged", ch1.channels.length === 2 && ch1.active_channel_id === "UC1" && ch1.channels.find((c: any) => c.channel_id === "UC2")?.title === "Second Channel", JSON.stringify(ch1));
const sw = await call("switch_channel", { channel: "second channel" });
check("switch_channel finds a channel by title", sw.active_channel_id === "UC2", JSON.stringify(sw));
const who2 = await call("whoami");
check("whoami reports the newly active channel", who2.channel_id === "UC2" && who2.channel === "Second Channel", JSON.stringify(who2));
await call("list_my_videos", {});
check("after a switch YouTube tools use the new channel's own credentials", ytAuth.at(-1) === "fresh:new-yt-refresh", ytAuth.at(-1));
const back = await call("switch_channel", { channel: "UC1" });
check("switch_channel accepts a channel id and switches back", back.active_channel_id === "UC1");
const bad = await call("switch_channel", { channel: "nope" }).then(() => "", (e: Error) => e.message);
check("an unknown channel gives a helpful error", /No linked channel/.test(bad), bad);
const stale = await GET(new Request(`https://uploader.test/google/callback?code=abc&state=${addUrl.searchParams.get("state")}`));
check("an add-channel link cannot be reused", stale.status === 400);

// ------------------------------------------------------------------ 15. Several channels at once
// The active channel is UC1 here; `channel` picks another one for a single call without switching.
const dThumb2 = await toDrive(thPath, "image/jpeg");
let n = ytAuth.length;
await Promise.all([call("list_my_videos", { channel: "UC1" }), call("list_my_videos", { channel: "Second Channel" }), call("get_video_stats", { channel: "UC2" }), call("get_video_stats", {})]);
const used = new Set(ytAuth.slice(n));
check("calls for different channels run at the same time, each with its own channel's token", used.size === 2 && used.has("fresh:r2") && used.has("fresh:new-yt-refresh"), [...used].join(" "));
check("naming a channel does not change the active one", (await call("whoami")).channel_id === "UC1");
n = ytAuth.length;
const [upA, upB] = await Promise.all([
  call("upload_video", { drive_file: dKeep.id, title: "To channel one", delete_from_drive: false, thumbnail_drive_file: dThumb2.id }),
  call("upload_video", { drive_file: dKeep.id, title: "To channel two", delete_from_drive: false, thumbnail_drive_file: dThumb2.id, channel: "UC2" }),
]);
check("the same Drive video uploads to two channels at once", upA.status === "done" && upB.status === "done" && upA.video_id !== upB.video_id, JSON.stringify([upA.status, upB.status]));
const jobB = (await sql`SELECT extras FROM jobs WHERE video_id = ${upB.video_id}`)[0];
check("an upload remembers its channel, so its thumbnail goes to the same channel", jobB.extras.channel_id === "UC2" && upB.extras.some((x: string) => x.startsWith("thumbnail set")) &&
  ytAuth.slice(n).filter((t) => t === "fresh:new-yt-refresh").length >= 2 && ytAuth.slice(n).filter((t) => t === "fresh:r2").length >= 2, ytAuth.slice(n).join(" "));
const before = log.length;
await call("list_comments", { channel: "second" });
check("list_comments reads the named channel's comments", log.slice(before).some((l) => l.includes("allThreadsRelatedToChannelId=UC2")), log.slice(before).join(" | "));
const unknown = await call("list_my_videos", { channel: "UCnope" }).then(() => "", (e: Error) => e.message);
check("an unknown channel on any tool gives a clear error", /No linked channel/.test(unknown), unknown);

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
server.close(); await pg.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
