/**
 * TubeDrop - a remote MCP server (Streamable HTTP, stateless JSON responses) that
 * uploads videos from Google Drive to YouTube. Sign-in is OAuth 2.1, delegated to Google.
 */
import { authenticate, authorize, authServerMetadata, googleCallback, protectedResourceMetadata, register, token } from "../lib/oauth.js";
import { ToolError } from "../lib/google.js";
import { connectCallback, connectStart, serveMedia } from "../lib/instagram.js";
import { callTool, tools } from "../lib/tools.js";
import { baseUrl, html, json } from "../lib/util.js";

const SERVER_INFO = { name: "tubedrop", title: "TubeDrop", version: "1.1.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-allow-methods": "GET, POST, OPTIONS, DELETE",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
};

function withCors(r: Response): Response {
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

async function handleRpc(msg: Rpc, userId: string, req: Request): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null;                      // notifications get no reply
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Uploads videos to the user's YouTube channel. To send a local file: get_upload_url (kind 'drive') and PUT the bytes " +
          "to the returned URL, then upload_video with the Drive file id (and thumbnail/captions Drive ids); the Drive copies " +
          "are deleted once YouTube has them. Upload as private or scheduled by default, and only make a video public when " +
          "the user has clearly said so in this conversation. Large uploads take several continue_upload calls." +
          " If Instagram is set up, instagram_publish_reel posts a Drive video as a Reel; a Reel is public as soon as it is " +
          "published, so only post one when the user has clearly said to in this conversation.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools() });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      try {
        const out = await callTool(userId, name, args, req);
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: Array.isArray(out) ? { items: out } : out });
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function mcp(req: Request): Promise<Response> {
  if (req.method === "GET") return new Response("This MCP server does not open an event stream.", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  const userId = await authenticate(req);
  if (!userId) {
    return json({ error: "unauthorized" }, 401, {
      "www-authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
    });
  }
  let body: Rpc | Rpc[];
  try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(m, userId, req)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleRpc(body, userId, req);
  return out ? json(out) : new Response(null, { status: 202 });
}

function home(req: Request): Response {
  const base = baseUrl(req);
  return html(`<h1>TubeDrop</h1>
<p>A connector that lets Claude upload videos to your own YouTube channel, with your own Google sign-in.</p>
<p>Add it in Claude: <b>Customize &rarr; Connectors &rarr; Add custom connector</b>, with this URL:</p>
<p><code>${base}/mcp</code></p>`);
}

async function route(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (path.startsWith("/.well-known/oauth-protected-resource")) return protectedResourceMetadata(req);
  if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration")) return authServerMetadata(req);
  if (path === "/register" && req.method === "POST") return register(req);
  if (path === "/authorize") return authorize(req);
  if (path === "/google/callback") return googleCallback(req);
  if (path === "/token" && req.method === "POST") return token(req);
  if (path === "/mcp") return mcp(req);
  if (path === "/instagram/connect") return connectStart(req);
  if (path === "/instagram/callback") return connectCallback(req);
  const media = /^\/ig\/media\/([A-Za-z0-9_-]+)\/(video|cover)$/.exec(path);
  if (media && (req.method === "GET" || req.method === "HEAD")) return serveMedia(req, media[1], media[2]);
  if (path === "/" || path === "/api/index") return home(req);
  return json({ error: "not_found" }, 404);
}

async function handler(req: Request): Promise<Response> {
  try {
    return withCors(await route(req));
  } catch (e) {
    console.error(e);
    return withCors(json({ error: "server_error", message: (e as Error).message }, 500));
  }
}

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
export const DELETE = handler;
export const HEAD = handler;
