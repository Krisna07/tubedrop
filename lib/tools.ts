import { accessToken, driveBytes, driveId, driveMeta, driveSearch, gfetch, gjson, ToolError } from "./google.js";
import { continuePublish, instagramEnabled, listMedia, publishingLimit, publishReel, whoamiInstagram } from "./instagram.js";
import { baseUrl, db, decrypt, encrypt, env, randomId } from "./util.js";

const YT = "https://www.googleapis.com/youtube/v3";
const UPLOADS_FOLDER_NAME = "TubeDrop Uploads";
// The connector's own Drive folder, marked with an app property (folders made before the rename used 'dubiousArchive').
const UPLOADS_FOLDER_Q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false and " +
  "(appProperties has { key='tubedrop' and value='uploads' } or appProperties has { key='dubiousArchive' and value='uploads' })";
const YT_UP = "https://www.googleapis.com/upload/youtube/v3";
const CHUNK = 32 * 1024 * 1024;                 // multiple of 256 KiB, as YouTube requires
const BUDGET_MS = Number(process.env.PUMP_SECONDS ?? 240) * 1000;

// ---------------------------------------------------------------- tool definitions

const videoFields = {
  title: { type: "string", description: "Video title, max 100 characters." },
  description: { type: "string", description: "Video description, max 5000 bytes. Timestamps like 0:00 Intro become chapters." },
  tags: { type: "array", items: { type: "string" }, description: "Tags (500 characters total)." },
  category_id: { type: "string", description: "YouTube category id. 1 Film & Animation, 22 People & Blogs, 23 Comedy, 24 Entertainment, 27 Education. Default 24." },
  privacy: { type: "string", enum: ["private", "unlisted", "public"], description: "Default private. Use 'private' together with publish_at to schedule." },
  publish_at: { type: "string", description: "ISO 8601 time to publish (e.g. 2026-10-28T19:00:00+11:00). Requires privacy 'private'." },
  made_for_kids: { type: "boolean", description: "Self-declared made for kids. Default false." },
  contains_synthetic_media: { type: "boolean", description: "Discloses altered or synthetic (AI) content. Default true." },
  default_language: { type: "string", description: "Language of title/description, e.g. 'en'. Default 'en'." },
  default_audio_language: { type: "string", description: "Spoken language, e.g. 'en-GB'. Default 'en'." },
  embeddable: { type: "boolean" },
  public_stats_viewable: { type: "boolean" },
  license: { type: "string", enum: ["youtube", "creativeCommon"] },
  has_paid_product_placement: { type: "boolean" },
} as const;

export const TOOLS = [
  {
    name: "whoami",
    description: "Show which Google account and YouTube channel this connector is signed in to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_drive_files",
    description: "Search the user's Google Drive for files by name, newest first. Use it to find the video, thumbnail and .srt to upload.",
    inputSchema: {
      type: "object",
      properties: {
        name_contains: { type: "string", description: "Part of the file name. Empty lists the newest files." },
        kind: { type: "string", enum: ["any", "video", "image"], description: "Default any." },
      },
    },
  },
  {
    name: "import_from_github",
    description:
      "Copy a rendered file (video, thumbnail or captions) from a branch of the private GitHub media repo into the " +
      "Google Drive folder 'TubeDrop Uploads'. Files over 95 MB are stored as <name>.part001, .part002...; " +
      "pass the plain name and the parts are joined. Returns drive_file_id when done; pass it to upload_video. Big videos " +
      "take several calls: if status is 'in_progress', call continue_upload with the job_id.",
    inputSchema: {
      type: "object",
      required: ["file", "branch"],
      properties: {
        file: { type: "string", description: "File name (or path) on the branch, e.g. 'the-forgotten-thread.mp4'." },
        branch: { type: "string", description: "Branch holding the files, e.g. 'media/the-forgotten-thread'." },
        folder_name: { type: "string", description: "Drive folder name used if the folder has to be created." },
      },
    },
  },
  {
    name: "upload_video",
    description:
      "Upload a video from Google Drive to the user's YouTube channel, with all metadata. Optionally sets the thumbnail, " +
      "adds captions and adds it to a playlist once the upload finishes, then deletes those files from the connector's Drive " +
      "uploads folder (delete_from_drive, default true). To get a local file into Drive first, use get_upload_url with kind " +
      "'drive'. Large files take several calls: if the result says " +
      "'in_progress', call continue_upload with the job_id until it says 'done'. Never make a video public without the user's " +
      "explicit go-ahead in the conversation; default to private or a scheduled publish_at.",
    inputSchema: {
      type: "object",
      required: ["drive_file", "title"],
      properties: {
        drive_file: { type: "string", description: "Google Drive file ID or share link of the video." },
        ...videoFields,
        thumbnail_drive_file: { type: "string", description: "Drive ID/link of a JPG or PNG thumbnail (max 2 MB, 1280x720)." },
        captions_drive_file: { type: "string", description: "Drive ID/link of an .srt or .vtt captions file." },
        captions_language: { type: "string", description: "Captions language, default 'en'." },
        captions_name: { type: "string", description: "Captions track name, default 'English'." },
        playlist_id: { type: "string", description: "Playlist to add the video to." },
        delete_from_drive: { type: "boolean", description: "After YouTube has the whole file, delete the video, thumbnail and captions files from Drive. Only files in the connector's own uploads folder are ever deleted. Default true." },
      },
    },
  },
  {
    name: "get_upload_url",
    description:
      "Direct upload without GitHub or Drive. Opens a one-time Google resumable upload session and returns its URL; the " +
      "caller then sends the file bytes with HTTP PUT (whole file, or chunks with Content-Range) to that URL. The URL is " +
      "only good for this one file and expires after about a week. kind 'video' creates a new YouTube video with the given " +
      "metadata (the final PUT response is the video resource, whose 'id' is the video id); 'thumbnail' and 'captions' " +
      "attach to an existing video_id; 'drive' stores the file in the Drive uploads folder. Never make a video public without " +
      "the user's explicit go-ahead; default to private or a scheduled publish_at.",
    inputSchema: {
      type: "object",
      required: ["kind", "size_bytes"],
      properties: {
        kind: { type: "string", enum: ["video", "thumbnail", "captions", "drive"] },
        size_bytes: { type: "number", description: "Exact size of the file in bytes." },
        mime: { type: "string", description: "Content type, e.g. video/mp4, image/jpeg, application/octet-stream. Guessed from file_name if omitted." },
        file_name: { type: "string", description: "File name (used for the Drive name and to guess the content type)." },
        video_id: { type: "string", description: "For thumbnail and captions: the video to attach to." },
        captions_language: { type: "string", description: "Captions language, default 'en'." },
        captions_name: { type: "string", description: "Captions track name, default 'English'." },
        ...videoFields,
      },
    },
  },
  {
    name: "continue_upload",
    description: "Continue a large transfer started by upload_video or import_from_github. Call repeatedly until status is 'done'.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
  },
  {
    name: "update_video",
    description: "Change metadata or privacy/schedule of an existing video. Only the fields you pass are changed.",
    inputSchema: { type: "object", required: ["video_id"], properties: { video_id: { type: "string" }, ...videoFields } },
  },
  {
    name: "set_thumbnail",
    description: "Set a custom thumbnail from a Drive image (JPG/PNG, max 2 MB). The channel must be phone-verified.",
    inputSchema: { type: "object", required: ["video_id", "drive_file"], properties: { video_id: { type: "string" }, drive_file: { type: "string" }, delete_from_drive: { type: "boolean", description: "Delete the image from Drive afterwards (only if it is in the connector's uploads folder). Default true." } } },
  },
  {
    name: "add_captions",
    description: "Upload an .srt/.vtt captions track from Drive to a video.",
    inputSchema: {
      type: "object",
      required: ["video_id", "drive_file"],
      properties: { video_id: { type: "string" }, drive_file: { type: "string" }, language: { type: "string" }, name: { type: "string" }, delete_from_drive: { type: "boolean", description: "Delete the captions file from Drive afterwards (only if it is in the connector's uploads folder). Default true." } },
    },
  },
  {
    name: "sketchfab_search",
    description:
      "Search Sketchfab for free downloadable 3D models usable on a monetised channel (CC0 or CC-BY only; CC-BY needs " +
      "a credit line in the video description). Returns uid, name, author, licence, face count and a preview link.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'amphora', 'diving helmet', 'roman galley'." },
        max_faces: { type: "number", description: "Skip models above this many faces (keeps renders fast). Default 150000." },
        count: { type: "number", description: "Results to return, default 12, max 24." },
      },
    },
  },
  {
    name: "sketchfab_save_model",
    description:
      "Download a Sketchfab model (GLB) and commit it to the media repo at assets/models/<name>.glb, and record its " +
      "author and licence in assets/models/CREDITS.md. Needs write access to the repo for the connector's GitHub token.",
    inputSchema: {
      type: "object",
      required: ["uid", "name"],
      properties: {
        uid: { type: "string", description: "Sketchfab model uid from sketchfab_search." },
        name: { type: "string", description: "Short file-safe name, e.g. 'amphora-roman-01'." },
      },
    },
  },
  {
    name: "list_my_videos",
    description: "List the channel's most recent uploads with privacy, scheduled time and processing status.",
    inputSchema: { type: "object", properties: { max: { type: "number", description: "Default 15, max 50." } } },
  },
  {
    name: "list_playlists",
    description: "List the channel's playlists (id and title).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_playlist",
    description: "Create a playlist.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" }, description: { type: "string" }, privacy: { type: "string", enum: ["private", "unlisted", "public"] } },
    },
  },
];

const INSTAGRAM_TOOLS = [
  {
    name: "instagram_publish_reel",
    description:
      "Publish a video from Google Drive to the owner's Instagram account (shown by whoami) as a Reel. A Reel is PUBLIC as soon as it is " +
      "published (Instagram has no private or scheduled posts through the API), so only call this after the user has " +
      "clearly said to post it in this conversation, and pass user_confirmed: true. Video: MP4/MOV, H.264 or HEVC, AAC " +
      "audio, 3 s to 15 min, 9:16, at most 300 MB. To get a local file into Drive first, use get_upload_url with kind " +
      "'drive'. Instagram takes a while to process the video: if the result says 'in_progress', wait about a minute and " +
      "call instagram_continue_publish with the job_id. The Drive files are deleted afterwards (delete_from_drive, default true).",
    inputSchema: {
      type: "object",
      required: ["drive_file", "user_confirmed"],
      properties: {
        drive_file: { type: "string", description: "Google Drive file ID or share link of the video." },
        caption: { type: "string", description: "Caption, max 2,200 characters, at most 30 hashtags and 20 @mentions." },
        cover_drive_file: { type: "string", description: "Drive ID/link of a JPEG cover image (9:16, max 8 MB). Overrides thumb_offset_ms." },
        thumb_offset_ms: { type: "number", description: "Use the frame at this many milliseconds as the cover. Default 0." },
        share_to_feed: { type: "boolean", description: "Also show the Reel in the profile feed grid. Default true." },
        is_ai_generated: { type: "boolean", description: "Label the Reel as AI-generated content." },
        collaborators: { type: "array", items: { type: "string" }, description: "Up to 3 Instagram usernames to invite as collaborators." },
        delete_from_drive: { type: "boolean", description: "After publishing, delete the video and cover from Drive (only if they are in the connector's uploads folder). Default true." },
        user_confirmed: { type: "boolean", description: "Must be true: the user has explicitly said to publish this Reel publicly." },
      },
    },
  },
  {
    name: "instagram_continue_publish",
    description: "Check on a Reel started by instagram_publish_reel and publish it once Instagram has processed the video. Call about once a minute until status is 'done'.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
  },
  {
    name: "instagram_list_media",
    description: "List the Instagram account's most recent posts and Reels, plus how many API posts are used of the 24-hour limit.",
    inputSchema: { type: "object", properties: { max: { type: "number", description: "Default 12, max 50." } } },
  },
];

/** The tools this install offers; the Instagram ones only when META_ACCESS_TOKEN is set. */
export const tools = () => (instagramEnabled() ? [...TOOLS, ...INSTAGRAM_TOOLS] : TOOLS);

// ---------------------------------------------------------------- helpers

type Args = Record<string, any>;

function snippetFrom(a: Args, base: Args = {}) {
  const s: Args = { ...base };
  if (a.title !== undefined) {
    if (a.title.length > 100) throw new ToolError("Title is longer than 100 characters.");
    s.title = a.title;
  }
  if (a.description !== undefined) s.description = a.description;
  if (a.tags !== undefined) s.tags = a.tags;
  s.categoryId = a.category_id ?? s.categoryId ?? "24";
  if (a.default_language !== undefined || !s.defaultLanguage) s.defaultLanguage = a.default_language ?? s.defaultLanguage ?? "en";
  if (a.default_audio_language !== undefined || !s.defaultAudioLanguage)
    s.defaultAudioLanguage = a.default_audio_language ?? s.defaultAudioLanguage ?? "en";
  return s;
}

function statusFrom(a: Args, base: Args = {}, isNew = false) {
  const s: Args = {};
  for (const k of ["privacyStatus", "publishAt", "embeddable", "publicStatsViewable", "license", "selfDeclaredMadeForKids", "containsSyntheticMedia"]) {
    if (base[k] !== undefined) s[k] = base[k];
  }
  if (a.privacy !== undefined) {
    s.privacyStatus = a.privacy;
    if (a.privacy !== "private" && a.publish_at === undefined) delete s.publishAt;   // publish now: drop the schedule
  }
  if (isNew && s.privacyStatus === undefined) s.privacyStatus = "private";
  if (a.publish_at !== undefined) {
    const d = new Date(a.publish_at);
    if (isNaN(d.getTime())) throw new ToolError("publish_at is not a valid date.");
    s.publishAt = d.toISOString();
    s.privacyStatus = "private";
  }
  if (a.made_for_kids !== undefined || isNew) s.selfDeclaredMadeForKids = a.made_for_kids ?? false;
  if (a.contains_synthetic_media !== undefined || isNew) s.containsSyntheticMedia = a.contains_synthetic_media ?? true;
  if (a.embeddable !== undefined) s.embeddable = a.embeddable;
  if (a.public_stats_viewable !== undefined) s.publicStatsViewable = a.public_stats_viewable;
  if (a.license !== undefined) s.license = a.license;
  return s;
}

const watchUrl = (id: string) => `https://youtu.be/${id}`;

function multipartRelated(meta: unknown, body: ArrayBuffer, mime: string) {
  const boundary = "b_" + randomId(12);
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const enc = new TextEncoder();
  const a = enc.encode(head), c = enc.encode(tail), b = new Uint8Array(body);
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a, 0); out.set(b, a.length); out.set(c, a.length + b.length);
  return { body: out, contentType: `multipart/related; boundary=${boundary}` };
}

/** Delete a Drive file, but only if it sits in the connector's own uploads folder. Returns a note for the result. */
export async function deleteIfOurs(dr: string, ref: string): Promise<string> {
  const id = driveId(ref);
  try {
    const q = UPLOADS_FOLDER_Q;
    const folders = await gjson<{ files: { id: string }[] }>(dr, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=10`);
    const meta = await gjson<{ name: string; parents?: string[] }>(dr, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,parents&supportsAllDrives=true`);
    const ours = new Set((folders.files ?? []).map((f) => f.id));
    if (!(meta.parents ?? []).some((p) => ours.has(p))) return `kept ${meta.name} in Drive (not in the uploads folder)`;
    const r = await gfetch(dr, `https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true`, { method: "DELETE" });
    if (r.status === 204 || r.status === 200 || r.status === 404) return `deleted ${meta.name} from Drive`;
    return `could NOT delete ${meta.name} from Drive (${r.status}): ${(await r.text()).slice(0, 200)}`;
  } catch (e) {
    return `could NOT delete Drive file ${id}: ${(e as Error).message}`;
  }
}

async function setThumbnail(dr: string, yt: string, videoId: string, ref: string) {
  const id = driveId(ref);
  const meta = await driveMeta(dr, id);
  if (!meta.mimeType.startsWith("image/")) throw new ToolError(`${meta.name} is not an image.`);
  if (Number(meta.size ?? 0) > 2 * 1024 * 1024) throw new ToolError(`${meta.name} is over YouTube's 2 MB thumbnail limit. Save it as a JPG.`);
  const bytes = await driveBytes(dr, id);
  await gjson(yt, `${YT_UP}/thumbnails/set?videoId=${videoId}&uploadType=media`, {
    method: "POST",
    headers: { "content-type": meta.mimeType },
    body: bytes,
  });
  return meta.name;
}

async function addCaptions(dr: string, yt: string, videoId: string, ref: string, language = "en", name = "English") {
  const id = driveId(ref);
  const meta = await driveMeta(dr, id);
  const bytes = await driveBytes(dr, id);
  const mp = multipartRelated({ snippet: { videoId, language, name, isDraft: false } }, bytes, "application/octet-stream");
  await gjson(yt, `${YT_UP}/captions?part=snippet&uploadType=multipart`, {
    method: "POST",
    headers: { "content-type": mp.contentType },
    body: mp.body,
  });
  return meta.name;
}

async function addToPlaylist(token: string, videoId: string, playlistId: string) {
  await gjson(token, `${YT}/playlistItems?part=snippet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }),
  });
}

// ---------------------------------------------------------------- Sketchfab -> GitHub assets

const SKF = "https://api.sketchfab.com/v3";
const OK_LICENCES = ["cc0", "by"];
async function skf<T = any>(path: string): Promise<T> {
  const r = await fetch(`${SKF}${path}`, { headers: { authorization: `Token ${env("SKETCHFAB_TOKEN")}` } });
  const text = await r.text();
  if (!r.ok) throw new ToolError(`Sketchfab error ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function sketchfabSearch(a: Args) {
  const maxFaces = Number(a.max_faces ?? 150000), count = Math.min(24, Number(a.count ?? 12));
  const out: Args[] = [];
  for (const lic of OK_LICENCES) {
    const q = new URLSearchParams({ type: "models", q: a.query, downloadable: "true", license: lic, sort_by: "-likeCount", count: "24" });
    const r = await skf<{ results: Args[] }>(`/search?${q}`);
    for (const m of r.results ?? []) {
      if ((m.faceCount ?? 0) > maxFaces) continue;
      out.push({ uid: m.uid, name: m.name, author: m.user?.username, licence: m.license?.label ?? lic, faces: m.faceCount, likes: m.likeCount, url: m.viewerUrl });
    }
  }
  return out.sort((x, y) => (y.likes ?? 0) - (x.likes ?? 0)).slice(0, count);
}

async function ghPut(path: string, content: Buffer | string, message: string) {
  const url = `https://api.github.com/repos/${GH_REPO()}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const cur = await fetch(`${url}?ref=main`, { headers: { ...GH_HEADERS(), accept: "application/vnd.github+json" } });
  const sha = cur.ok ? ((await cur.json()) as { sha: string }).sha : undefined;
  const body = { message, branch: "main", content: Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content).toString("base64"), ...(sha ? { sha } : {}) };
  const r = await fetch(url, { method: "PUT", headers: { ...GH_HEADERS(), accept: "application/vnd.github+json", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 403 || r.status === 404) throw new ToolError(`GitHub refused the write (${r.status}). The connector's GitHub token needs "Contents: Read and write" on ${GH_REPO()}.`);
    throw new ToolError(`GitHub write failed (${r.status}): ${t.slice(0, 300)}`);
  }
}

async function sketchfabSave(a: Args) {
  const name = String(a.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!name) throw new ToolError("Give the model a short name.");
  const m = await skf<Args>(`/models/${encodeURIComponent(a.uid)}`);
  const lic = m.license?.slug ?? m.license?.label ?? "";
  if (!OK_LICENCES.some((l) => String(lic).toLowerCase().includes(l)) && !/cc0|public domain|attribution\b/i.test(m.license?.label ?? ""))
    throw new ToolError(`"${m.name}" is licensed ${m.license?.label ?? "unknown"}; only CC0 and CC-BY models are allowed.`);
  if (/noncommercial|no ?deriv|sharealike/i.test(m.license?.label ?? "")) throw new ToolError(`"${m.name}" is ${m.license?.label}; not usable here.`);
  const dl = await skf<Args>(`/models/${encodeURIComponent(a.uid)}/download`);
  const glb = dl.glb;
  if (!glb?.url) throw new ToolError("Sketchfab did not offer a GLB download for this model.");
  if ((glb.size ?? 0) > 60 * 1024 * 1024) throw new ToolError(`That model is ${Math.round(glb.size / 1048576)} MB; pick a lighter one (under 60 MB).`);
  const bin = Buffer.from(await (await fetch(glb.url)).arrayBuffer());
  const path = `assets/models/${name}.glb`;
  await ghPut(path, bin, `asset: ${name} (${m.name} by ${m.user?.username}, ${m.license?.label})`);
  const credit = `| ${name}.glb | [${String(m.name).replace(/\|/g, "/")}](${m.viewerUrl}) | ${m.user?.displayName ?? m.user?.username} | ${m.license?.label} |\n`;
  const credUrl = `https://api.github.com/repos/${GH_REPO()}/contents/assets/models/CREDITS.md?ref=main`;
  const cur = await fetch(credUrl, { headers: { ...GH_HEADERS(), accept: "application/vnd.github.raw" } });
  const old = cur.ok ? await cur.text() : "# 3D model credits\n\nCC-BY models must be credited in the description of every video that uses them.\n\n| File | Model | Author | Licence |\n|---|---|---|---|\n";
  await ghPut("assets/models/CREDITS.md", old.includes(`| ${name}.glb |`) ? old : old + credit, `credits: ${name}`);
  return { saved: path, size_mb: Math.round(bin.length / 104857.6) / 10, model: m.name, author: m.user?.displayName ?? m.user?.username, licence: m.license?.label,
           credit_line: `"${m.name}" by ${m.user?.displayName ?? m.user?.username} (${m.viewerUrl}), ${m.license?.label}` };
}

// ---------------------------------------------------------------- GitHub media repo -> Drive

const GH_REPO = () => {
  const r = process.env.MEDIA_REPO;
  if (!r) throw new ToolError("The GitHub tools need MEDIA_REPO (owner/repo) set on the server.");
  return r;
};
const GH_HEADERS = () => ({ authorization: `Bearer ${env("GITHUB_TOKEN")}`, "user-agent": "tubedrop", "x-github-api-version": "2022-11-28" });

type Part = { path: string; size: number; start: number };

/** A file on a branch of the media repo, either whole or split as <file>.part001, <file>.part002, ... */
async function ghFile(file: string, branch: string): Promise<{ parts: Part[]; total: number }> {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const base = file.slice(file.lastIndexOf("/") + 1);
  const r = await fetch(`https://api.github.com/repos/${GH_REPO()}/contents/${dir}?ref=${encodeURIComponent(branch)}`, { headers: { ...GH_HEADERS(), accept: "application/vnd.github+json" } });
  if (!r.ok) throw new ToolError(`Branch "${branch}" or folder not found in ${GH_REPO()} (${r.status}).`);
  const items = (await r.json()) as { name: string; path: string; size: number; type: string }[];
  let found = items.filter((i) => i.type === "file" && i.name === base);
  if (!found.length) found = items.filter((i) => i.type === "file" && i.name.startsWith(base + ".part")).sort((x, y) => x.name.localeCompare(y.name));
  if (!found.length) throw new ToolError(`No "${base}" on branch ${branch}. Files: ${items.map((i) => i.name).join(", ")}`);
  let start = 0;
  const parts = found.map((i) => { const p = { path: i.path, size: i.size, start }; start += i.size; return p; });
  return { parts, total: start };
}

async function ghBytes(meta: Args, range: [number, number]): Promise<ArrayBuffer> {
  const out: Uint8Array[] = [];
  for (const p of meta.parts as Part[]) {
    const s = Math.max(range[0], p.start), e = Math.min(range[1], p.start + p.size - 1);
    if (s > e) continue;
    const url = `https://raw.githubusercontent.com/${GH_REPO()}/${encodeURIComponent(meta.branch)}/${p.path.split("/").map(encodeURIComponent).join("/")}`;
    const r = await fetch(url, { headers: { ...GH_HEADERS(), range: `bytes=${s - p.start}-${e - p.start}` } });
    if (r.status !== 206 && r.status !== 200) throw new ToolError(`Could not read ${p.path} from GitHub (${r.status}).`);
    let buf = new Uint8Array(await r.arrayBuffer());
    if (r.status === 200 && buf.byteLength > e - s + 1) buf = buf.slice(s - p.start, e - p.start + 1);
    out.push(buf);
  }
  const total = out.reduce((n, b) => n + b.byteLength, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const b of out) { joined.set(b, o); o += b.byteLength; }
  return joined.buffer;
}

async function uploadsFolder(dr: string, name: string): Promise<string> {
  const q = UPLOADS_FOLDER_Q;
  const found = await gjson<{ files: { id: string }[] }>(dr, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
  if (found.files?.[0]) return found.files[0].id;
  const made = await gjson<{ id: string }>(dr, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", appProperties: { tubedrop: "uploads" } }),
  });
  return made.id;
}

async function startImport(userId: string, a: Args) {
  const sql = await db();
  const dr = await accessToken(userId, "drive");
  const branch = a.branch ?? "main";
  const src = await ghFile(a.file, branch);
  const name = a.file.slice(a.file.lastIndexOf("/") + 1);
  const folderId = await uploadsFolder(dr, a.folder_name ?? UPLOADS_FOLDER_NAME);
  const ext = name.toLowerCase().split(".").pop();
  const mime = ext === "mp4" ? "video/mp4" : ext === "mov" ? "video/quicktime" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "text/plain";
  const init = await gfetch(dr, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size", {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mime, "x-upload-content-length": String(src.total) },
    body: JSON.stringify({ name, parents: [folderId], mimeType: mime }),
  });
  if (!init.ok) throw new ToolError(`Drive refused the upload (${init.status}): ${(await init.text()).slice(0, 300)}. If this mentions insufficient permissions, disconnect and reconnect the connector.`);
  const session = init.headers.get("location");
  if (!session) throw new ToolError("Drive did not return an upload session.");
  const jobId = "imp_" + randomId(9);
  await sql`INSERT INTO jobs (id, user_id, drive_id, session_uri_enc, total, uploaded, mime, meta, extras, status, kind)
            VALUES (${jobId}, ${userId}, '', ${encrypt(session)}, ${src.total}, 0, ${mime},
                    ${JSON.stringify({ name, branch, parts: src.parts, folder_id: folderId })}, '{}', 'uploading', 'import')`;
  return { file: name, branch, ...(await pump(userId, jobId)) };
}

async function finishImport(jobId: string, file: { id: string }) {
  const sql = await db();
  await sql`UPDATE jobs SET status = 'done', drive_id = ${file.id}, uploaded = total, updated_at = now() WHERE id = ${jobId}`;
  const job = (await sql`SELECT * FROM jobs WHERE id = ${jobId}`)[0];
  return importSummary(job);
}

function importSummary(job: Args) {
  return { status: "done", drive_file_id: job.drive_id, name: job.meta?.name, size_mb: Math.round(Number(job.total) / 1048576 * 10) / 10 };
}

// ---------------------------------------------------------------- the upload pump

async function pump(userId: string, jobId: string) {
  const started = Date.now();
  const sql = await db();
  const dr = await accessToken(userId, "drive");
  let job = (await sql`SELECT * FROM jobs WHERE id = ${jobId} AND user_id = ${userId}`)[0];
  if (!job) throw new ToolError(`No upload job ${jobId}.`);
  if (job.kind === "ig") throw new ToolError(`${jobId} is an Instagram Reel; use instagram_continue_publish.`);
  const isImport = job.kind === "import";
  if (job.status === "done") return isImport ? importSummary(job) : summary(job);
  if (job.status === "failed") throw new ToolError(`That upload failed earlier: ${job.error}`);
  const session = decrypt(job.session_uri_enc);
  const total = Number(job.total);
  let offset = Number(job.uploaded);

  // Ask YouTube where it got to, in case a previous call died mid-chunk.
  const probe = await fetch(session, { method: "PUT", headers: { "content-range": `bytes */${total}` } });
  if (probe.status === 200 || probe.status === 201) return isImport ? finishImport(jobId, await probe.json()) : finish(userId, jobId, await probe.json());
  if (probe.status === 308) {
    const r = probe.headers.get("range");
    offset = r ? Number(r.split("-")[1]) + 1 : 0;
  } else if (probe.status === 404 || probe.status === 410) {
    await sql`UPDATE jobs SET status = 'failed', error = 'upload session expired', updated_at = now() WHERE id = ${jobId}`;
    throw new ToolError("The upload session expired (they last about a week). Start the transfer again.");
  }

  while (offset < total && Date.now() - started < BUDGET_MS) {
    const end = Math.min(offset + CHUNK, total) - 1;
    const bytes = isImport ? await ghBytes(job.meta, [offset, end]) : await driveBytes(dr, job.drive_id, [offset, end]);
    const r = await fetch(session, {
      method: "PUT",
      headers: { "content-length": String(bytes.byteLength), "content-range": `bytes ${offset}-${end}/${total}` },
      body: bytes,
    });
    if (r.status === 200 || r.status === 201) return isImport ? finishImport(jobId, await r.json()) : finish(userId, jobId, await r.json());
    if (r.status !== 308) {
      const text = await r.text();
      if (r.status >= 500) break;                      // transient: the next call resumes from YouTube's offset
      await sql`UPDATE jobs SET status = 'failed', error = ${text.slice(0, 500)}, updated_at = now() WHERE id = ${jobId}`;
      throw new ToolError(`${isImport ? "Drive" : "YouTube"} rejected the upload (${r.status}): ${text.slice(0, 300)}`);
    }
    const range = r.headers.get("range");
    offset = range ? Number(range.split("-")[1]) + 1 : end + 1;
    await sql`UPDATE jobs SET uploaded = ${offset}, updated_at = now() WHERE id = ${jobId}`;
  }
  job = (await sql`SELECT * FROM jobs WHERE id = ${jobId}`)[0];
  const pct = Math.floor((offset / total) * 100);
  return {
    status: "in_progress",
    job_id: jobId,
    uploaded_mb: Math.round(offset / 1048576),
    total_mb: Math.round(total / 1048576),
    percent: pct,
    next: `Call continue_upload with job_id "${jobId}".`,
  };
}

async function finish(userId: string, jobId: string, video: { id: string }) {
  const sql = await db();
  const dr = await accessToken(userId, "drive");
  const token = await accessToken(userId, "yt");
  const job = (await sql`SELECT * FROM jobs WHERE id = ${jobId}`)[0];
  const extras = (job.extras ?? {}) as Args;
  const notes: string[] = [];
  const cleanup: string[] = [job.drive_id];                     // YouTube has the whole video now
  if (extras.thumbnail_drive_file) {
    try { notes.push(`thumbnail set (${await setThumbnail(dr, token, video.id, extras.thumbnail_drive_file)})`); cleanup.push(extras.thumbnail_drive_file); }
    catch (e) { notes.push(`thumbnail NOT set (file kept in Drive for a retry): ${(e as Error).message}`); }
  }
  if (extras.captions_drive_file) {
    try { notes.push(`captions added (${await addCaptions(dr, token, video.id, extras.captions_drive_file, extras.captions_language, extras.captions_name)})`); cleanup.push(extras.captions_drive_file); }
    catch (e) { notes.push(`captions NOT added (file kept in Drive for a retry): ${(e as Error).message}`); }
  }
  if (extras.delete_from_drive !== false) {
    for (const ref of cleanup) notes.push(await deleteIfOurs(dr, ref));
  }
  if (extras.playlist_id) {
    try { await addToPlaylist(token, video.id, extras.playlist_id); notes.push("added to playlist"); }
    catch (e) { notes.push(`playlist NOT updated: ${(e as Error).message}`); }
  }
  await sql`UPDATE jobs SET status = 'done', video_id = ${video.id}, uploaded = total, extras = ${JSON.stringify({ ...extras, notes })}, updated_at = now() WHERE id = ${jobId}`;
  return summary({ ...job, status: "done", video_id: video.id, extras: { ...extras, notes } });
}

function summary(job: Args) {
  const meta = job.meta ?? {};
  return {
    status: "done",
    video_id: job.video_id,
    url: watchUrl(job.video_id),
    studio: `https://studio.youtube.com/video/${job.video_id}/edit`,
    privacy: meta.status?.privacyStatus,
    publish_at: meta.status?.publishAt ?? null,
    extras: job.extras?.notes ?? [],
    reminder: "YouTube is now processing the video. End screens and cards can only be added in YouTube Studio.",
  };
}

// ---------------------------------------------------------------- direct uploads (caller PUTs the bytes)

function guessMime(name = "", fallback = "application/octet-stream") {
  const ext = name.toLowerCase().split(".").pop();
  return ({ mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
            srt: "application/octet-stream", vtt: "text/vtt" } as Record<string, string>)[ext ?? ""] ?? fallback;
}

async function openSession(token: string, url: string, meta: unknown, mime: string, size: number, what: string) {
  const init = await gfetch(token, url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mime, "x-upload-content-length": String(size) },
    body: JSON.stringify(meta ?? {}),
  });
  if (!init.ok) throw new ToolError(`${what} refused to start the upload (${init.status}): ${(await init.text()).slice(0, 400)}`);
  const session = init.headers.get("location");
  if (!session) throw new ToolError(`${what} did not return an upload session.`);
  return session;
}

async function getUploadUrl(userId: string, a: Args) {
  const size = Number(a.size_bytes);
  if (!Number.isFinite(size) || size <= 0) throw new ToolError("size_bytes must be the file's exact size in bytes.");
  let url: string, meta: unknown, mime: string, token: string, what: string;
  switch (a.kind) {
    case "video": {
      if (!a.title) throw new ToolError("A video needs a title.");
      mime = a.mime ?? guessMime(a.file_name, "video/mp4");
      const m = { snippet: snippetFrom(a), status: statusFrom(a, {}, true) } as Args;
      if (a.has_paid_product_placement !== undefined) m.paidProductPlacementDetails = { hasPaidProductPlacement: a.has_paid_product_placement };
      const parts = ["snippet", "status", ...(m.paidProductPlacementDetails ? ["paidProductPlacementDetails"] : [])].join(",");
      url = `${YT_UP}/videos?uploadType=resumable&part=${parts}`; meta = m; token = await accessToken(userId, "yt"); what = "YouTube";
      break;
    }
    case "thumbnail":
      if (!a.video_id) throw new ToolError("thumbnail needs video_id.");
      if (size > 2 * 1024 * 1024) throw new ToolError("Thumbnails must be 2 MB or smaller.");
      mime = a.mime ?? guessMime(a.file_name, "image/jpeg");
      url = `${YT_UP}/thumbnails/set?videoId=${encodeURIComponent(a.video_id)}&uploadType=resumable`; meta = {}; token = await accessToken(userId, "yt"); what = "YouTube";
      break;
    case "captions":
      if (!a.video_id) throw new ToolError("captions needs video_id.");
      mime = a.mime ?? "application/octet-stream";
      url = `${YT_UP}/captions?part=snippet&uploadType=resumable`;
      meta = { snippet: { videoId: a.video_id, language: a.captions_language ?? "en", name: a.captions_name ?? "English", isDraft: false } };
      token = await accessToken(userId, "yt"); what = "YouTube";
      break;
    case "drive": {
      if (!a.file_name) throw new ToolError("drive needs file_name.");
      token = await accessToken(userId, "drive");
      mime = a.mime ?? guessMime(a.file_name);
      const folderId = await uploadsFolder(token, UPLOADS_FOLDER_NAME);
      url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size";
      meta = { name: a.file_name, parents: [folderId], mimeType: mime }; what = "Drive";
      break;
    }
    default:
      throw new ToolError("kind must be video, thumbnail, captions or drive.");
  }
  const session = await openSession(token, url, meta, mime, size, what);
  return {
    upload_url: session,
    method: "PUT",
    content_type: mime,
    size_bytes: size,
    how: "PUT the file bytes to upload_url with Content-Type set (curl -X PUT -H 'Content-Type: <type>' --data-binary @file '<upload_url>'). " +
         "For big files send chunks that are multiples of 256 KiB with 'Content-Range: bytes <start>-<end>/<total>'; a 308 reply means send the next chunk. " +
         "To resume, PUT an empty body with 'Content-Range: bytes */<total>' and read the Range header. A 200/201 reply ends the upload.",
  };
}

// ---------------------------------------------------------------- dispatcher

export async function callTool(userId: string, name: string, a: Args, req: Request): Promise<unknown> {
  const sql = await db();
  if (name.startsWith("instagram_") && !instagramEnabled()) throw new ToolError("Instagram is not set up on this server (META_ACCESS_TOKEN is missing).");
  switch (name) {
    case "whoami": {
      const u = (await sql`SELECT email, channel_id, channel_title FROM users WHERE id = ${userId}`)[0];
      const out: Args = { google_account: u?.email, channel: u?.channel_title, channel_id: u?.channel_id, channel_url: u?.channel_id ? `https://www.youtube.com/channel/${u.channel_id}` : null };
      if (instagramEnabled()) {
        try { out.instagram = await whoamiInstagram(); }
        catch (e) { out.instagram = { error: (e as Error).message }; }
      }
      return out;
    }
    case "instagram_publish_reel": {
      const dr = await accessToken(userId, "drive");
      const file = await driveMeta(dr, driveId(a.drive_file));
      let cover: { id: string; mimeType: string } | undefined;
      if (a.cover_drive_file) {
        const c = await driveMeta(dr, driveId(a.cover_drive_file));
        if (c.mimeType !== "image/jpeg") throw new ToolError(`${c.name} is ${c.mimeType}; Instagram covers must be JPEG.`);
        if (Number(c.size ?? 0) > 8 * 1024 * 1024) throw new ToolError(`${c.name} is over Instagram's 8 MB cover limit.`);
        cover = { id: c.id, mimeType: c.mimeType };
      }
      return publishReel(baseUrl(req), userId, a, file, cover);
    }
    case "instagram_continue_publish":
      return continuePublish(userId, a.job_id);
    case "instagram_list_media": {
      const media = await listMedia(a.max ?? 12);
      let limit: Args | null = null;
      try { limit = await publishingLimit(); } catch { /* optional */ }
      return { publishing_limit: limit, items: media };
    }
    case "find_drive_files": {
      const token = await accessToken(userId, "drive");
      const files = await driveSearch(token, a.name_contains ?? "", a.kind ?? "any");
      return files.map((f) => ({ ...f, size_mb: f.size ? Math.round(Number(f.size) / 1048576 * 10) / 10 : null }));
    }
    case "upload_video": {
      const token = await accessToken(userId, "yt");
      const id = driveId(a.drive_file);
      const file = await driveMeta(await accessToken(userId, "drive"), id);
      if (!file.mimeType.startsWith("video/")) throw new ToolError(`${file.name} is ${file.mimeType}, not a video.`);
      const meta = { snippet: snippetFrom(a), status: statusFrom(a, {}, true) } as Args;
      if (a.has_paid_product_placement !== undefined) meta.paidProductPlacementDetails = { hasPaidProductPlacement: a.has_paid_product_placement };
      const parts = ["snippet", "status", ...(meta.paidProductPlacementDetails ? ["paidProductPlacementDetails"] : [])].join(",");
      const init = await gfetch(token, `${YT_UP}/videos?uploadType=resumable&part=${parts}`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-length": String(file.size),
          "x-upload-content-type": file.mimeType,
        },
        body: JSON.stringify(meta),
      });
      if (!init.ok) {
        const t = await init.text();
        throw new ToolError(`YouTube refused to start the upload (${init.status}): ${t.slice(0, 400)}`);
      }
      const session = init.headers.get("location");
      if (!session) throw new ToolError("YouTube did not return an upload session.");
      const jobId = "job_" + randomId(9);
      const extras = {
        thumbnail_drive_file: a.thumbnail_drive_file, captions_drive_file: a.captions_drive_file,
        captions_language: a.captions_language ?? "en", captions_name: a.captions_name ?? "English", playlist_id: a.playlist_id,
        delete_from_drive: a.delete_from_drive !== false,
      };
      await sql`INSERT INTO jobs (id, user_id, drive_id, session_uri_enc, total, uploaded, mime, meta, extras, status)
                VALUES (${jobId}, ${userId}, ${id}, ${encrypt(session)}, ${Number(file.size)}, 0, ${file.mimeType},
                        ${JSON.stringify(meta)}, ${JSON.stringify(extras)}, 'uploading')`;
      return { file: file.name, ...(await pump(userId, jobId)) };
    }
    case "import_from_github":
      return startImport(userId, a);
    case "get_upload_url":
      return getUploadUrl(userId, a);
    case "continue_upload":
      return pump(userId, a.job_id);
    case "update_video": {
      const token = await accessToken(userId);
      const cur = await gjson<{ items: Args[] }>(token, `${YT}/videos?part=snippet,status&id=${encodeURIComponent(a.video_id)}`);
      const v = cur.items?.[0];
      if (!v) throw new ToolError(`Video ${a.video_id} was not found on this channel.`);
      const body: Args = { id: a.video_id, snippet: snippetFrom(a, v.snippet), status: statusFrom(a, v.status) };
      delete body.snippet.thumbnails; delete body.snippet.localized; delete body.snippet.publishedAt;
      delete body.snippet.channelId; delete body.snippet.channelTitle; delete body.snippet.liveBroadcastContent;
      if (a.has_paid_product_placement !== undefined) body.paidProductPlacementDetails = { hasPaidProductPlacement: a.has_paid_product_placement };
      const parts = Object.keys(body).filter((k) => k !== "id").join(",");
      const r = await gjson<Args>(token, `${YT}/videos?part=${parts}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { video_id: r.id, title: r.snippet?.title, privacy: r.status?.privacyStatus, publish_at: r.status?.publishAt ?? null, url: watchUrl(r.id) };
    }
    case "set_thumbnail": {
      const token = await accessToken(userId);
      const dr = await accessToken(userId, "drive");
      const out: Args = { ok: true, thumbnail: await setThumbnail(dr, token, a.video_id, a.drive_file) };
      if (a.delete_from_drive !== false) out.drive = await deleteIfOurs(dr, a.drive_file);
      return out;
    }
    case "add_captions": {
      const token = await accessToken(userId);
      const dr = await accessToken(userId, "drive");
      const out: Args = { ok: true, captions: await addCaptions(dr, token, a.video_id, a.drive_file, a.language, a.name) };
      if (a.delete_from_drive !== false) out.drive = await deleteIfOurs(dr, a.drive_file);
      return out;
    }
    case "sketchfab_search":
      return sketchfabSearch(a);
    case "sketchfab_save_model":
      return sketchfabSave(a);
    case "list_my_videos": {
      const token = await accessToken(userId);
      const ch = await gjson<{ items: Args[] }>(token, `${YT}/channels?part=contentDetails&mine=true`);
      const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return [];
      const max = Math.min(50, Math.max(1, Number(a.max ?? 15)));
      const pl = await gjson<{ items: Args[] }>(token, `${YT}/playlistItems?part=contentDetails&maxResults=${max}&playlistId=${uploads}`);
      const ids = (pl.items ?? []).map((i) => i.contentDetails.videoId).join(",");
      if (!ids) return [];
      const vids = await gjson<{ items: Args[] }>(token, `${YT}/videos?part=snippet,status,processingDetails&id=${ids}`);
      return (vids.items ?? []).map((v) => ({
        video_id: v.id, title: v.snippet.title, privacy: v.status.privacyStatus, publish_at: v.status.publishAt ?? null,
        upload_status: v.status.uploadStatus, processing: v.processingDetails?.processingStatus, url: watchUrl(v.id),
      }));
    }
    case "list_playlists": {
      const token = await accessToken(userId);
      const r = await gjson<{ items: Args[] }>(token, `${YT}/playlists?part=snippet,status&mine=true&maxResults=50`);
      return (r.items ?? []).map((p) => ({ playlist_id: p.id, title: p.snippet.title, privacy: p.status.privacyStatus }));
    }
    case "create_playlist": {
      const token = await accessToken(userId);
      const r = await gjson<Args>(token, `${YT}/playlists?part=snippet,status`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ snippet: { title: a.title, description: a.description ?? "" }, status: { privacyStatus: a.privacy ?? "public" } }),
      });
      return { playlist_id: r.id, title: r.snippet.title };
    }
    default:
      throw new ToolError(`Unknown tool ${name}`);
  }
}
