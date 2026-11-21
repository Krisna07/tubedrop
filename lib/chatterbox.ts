// Chatterbox Turbo voiceovers, generated on a Hugging Face Space (ResembleAI/chatterbox-turbo-demo by default).
// The Space caps text at 300 characters, so longer scripts are split at sentence ends, generated one piece at a
// time with the same voice and seed, and joined into one WAV.

import { ToolError } from "./google.js";

type Args = Record<string, any>;

const SPACE = () => (process.env.CHATTERBOX_SPACE || "ResembleAI/chatterbox-turbo-demo").trim();
const MAX_PIECE = 280;                 // under the Space's 300-character limit
export const MAX_TEXT = 4000;
const GAP_S = 0.12;                    // silence between pieces

export function spaceHost(space = SPACE()): string {
  if (/^https?:\/\//.test(space)) return space.replace(/\/+$/, "");
  const [owner, name] = space.split("/");
  if (!owner || !name) throw new ToolError(`CHATTERBOX_SPACE "${space}" should look like owner/space-name.`);
  return `https://${`${owner}-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.hf.space`;
}

const hfHeaders = (): Record<string, string> => (process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {});

/** Split a script into pieces of at most `max` characters, breaking at sentence ends, then commas, then spaces. */
export function splitScript(text: string, max = MAX_PIECE): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  const units: string[] = [];
  for (const s of sentences) {
    if (s.length <= max) { units.push(s); continue; }
    let rest = s;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" - "));
      if (cut < max * 0.4) cut = window.lastIndexOf(" ");
      if (cut <= 0) cut = max - 1;
      units.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) units.push(rest);
  }
  const pieces: string[] = [];
  for (const u of units) {
    const last = pieces.length - 1;
    if (last >= 0 && pieces[last].length + 1 + u.length <= max) pieces[last] += " " + u;
    else pieces.push(u);
  }
  return pieces;
}

// ---------------------------------------------------------------- WAV

export interface Pcm { rate: number; channels: number; bits: number; data: Uint8Array }

export function parseWav(buf: ArrayBuffer): Pcm {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new ToolError("Chatterbox did not return a WAV file.");
  let o = 12, fmt: Omit<Pcm, "data"> | null = null;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === "fmt ") {
      const format = v.getUint16(o + 8, true);
      if (format !== 1 && format !== 0xfffe) throw new ToolError(`Chatterbox returned an unsupported WAV encoding (${format}).`);
      fmt = { channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === "data") {
      if (!fmt) throw new ToolError("Chatterbox returned a WAV file with no format block.");
      const end = Math.min(buf.byteLength, o + 8 + (size === 0xffffffff || size === 0 ? buf.byteLength : size));
      return { ...fmt, data: new Uint8Array(buf, o + 8, end - o - 8) };
    }
    o += 8 + size + (size % 2);
  }
  throw new ToolError("Chatterbox returned a WAV file with no audio.");
}

export function joinWav(parts: Pcm[], gapS = GAP_S): { wav: Uint8Array; offsets: number[]; seconds: number } {
  const { rate, channels, bits } = parts[0];
  if (parts.some((p) => p.rate !== rate || p.channels !== channels || p.bits !== bits)) throw new ToolError("Chatterbox pieces came back in different audio formats.");
  const frame = channels * bits / 8;
  const gap = Math.round(rate * gapS) * frame;
  const dataLen = parts.reduce((n, p) => n + p.data.length, 0) + gap * (parts.length - 1);
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); put(8, "WAVE");
  put(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * frame, true); v.setUint16(32, frame, true); v.setUint16(34, bits, true);
  put(36, "data"); v.setUint32(40, dataLen, true);
  let o = 44;
  const offsets: number[] = [];
  parts.forEach((p, i) => {
    offsets.push((o - 44) / frame / rate);
    out.set(p.data, o); o += p.data.length;
    if (i < parts.length - 1) o += gap;              // zero bytes = silence
  });
  return { wav: out, offsets, seconds: dataLen / frame / rate };
}

// ---------------------------------------------------------------- the Space

async function spaceError(r: Response, what: string): Promise<never> {
  const t = (await r.text().catch(() => "")).slice(0, 300);
  const busy = r.status === 429 || r.status === 503 || /quota|queue|GPU|ZeroGPU|exceeded/i.test(t);
  throw new ToolError(`Chatterbox ${what} failed (${r.status})${t ? `: ${t}` : ""}.${busy ? " The free GPU is busy or out of quota; fall back to Kokoro for this run, or set HF_TOKEN on the server to use your own Hugging Face GPU quota." : ""}`);
}

/** Upload a reference clip to the Space and return the FileData to pass as audio_prompt_path. */
export async function uploadReference(host: string, bytes: ArrayBuffer, name: string, mime: string): Promise<Args> {
  const form = new FormData();
  form.append("files", new Blob([bytes], { type: mime }), name);
  const r = await fetch(`${host}/gradio_api/upload`, { method: "POST", headers: hfHeaders(), body: form, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) await spaceError(r, "reference upload");
  const [path] = (await r.json()) as string[];
  if (!path) throw new ToolError("Chatterbox did not accept the reference clip.");
  return { path, url: `${host}/gradio_api/file=${path}`, orig_name: name, mime_type: mime, meta: { _type: "gradio.FileData" } };
}

/** The Space's own default voice prompt, used when no reference clip is given. */
async function defaultPrompt(host: string): Promise<Args | null> {
  try {
    const info = (await fetch(`${host}/gradio_api/info`, { headers: hfHeaders(), signal: AbortSignal.timeout(30_000) }).then((r) => r.json())) as Args;
    const p = info?.named_endpoints?.["/generate"]?.parameters?.find((x: Args) => x.parameter_name === "audio_prompt_path");
    return p?.parameter_default ?? null;
  } catch { return null; }
}

export interface PieceOpts { prompt: Args | null; temperature: number; seed: number }

async function generatePiece(host: string, text: string, o: PieceOpts): Promise<Pcm> {
  const data = [text, o.prompt, o.temperature, o.seed, 0, 0.95, 1000, 1.2, true];
  const start = await fetch(`${host}/gradio_api/call/generate`, {
    method: "POST", headers: { ...hfHeaders(), "content-type": "application/json" }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(60_000),
  });
  if (!start.ok) await spaceError(start, "request");
  const { event_id } = (await start.json()) as { event_id?: string };
  if (!event_id) throw new ToolError("Chatterbox did not start the job.");
  const res = await fetch(`${host}/gradio_api/call/generate/${event_id}`, { headers: hfHeaders(), signal: AbortSignal.timeout(180_000) });
  if (!res.ok) await spaceError(res, "generation");
  const stream = await res.text();
  const events = [...stream.matchAll(/event:\s*(\w+)\s*\ndata:\s*(.*)/g)].map((m) => ({ event: m[1], data: m[2] }));
  const done = events.find((e) => e.event === "complete");
  if (!done) {
    const err = events.find((e) => e.event === "error")?.data;
    const busy = /quota|GPU|queue|exceeded/i.test(String(err));
    throw new ToolError(`Chatterbox could not generate "${text.slice(0, 40)}...": ${err && err !== "null" ? err.slice(0, 300) : "the Space returned an error"}.` +
      (busy ? " The free GPU is busy or out of quota; fall back to Kokoro for this run, or set HF_TOKEN on the server." : ""));
  }
  const out = JSON.parse(done.data) as Args[];
  const file = out?.[0];
  const url = file?.url ?? (file?.path ? `${host}/gradio_api/file=${file.path}` : null);
  if (!url) throw new ToolError("Chatterbox finished but returned no audio.");
  const audio = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(60_000) });
  if (!audio.ok) await spaceError(audio, "audio download");
  return parseWav(await audio.arrayBuffer());
}

export interface Voiceover { wav: Uint8Array; seconds: number; pieces: { text: string; start: number }[] }

export async function synthesize(text: string, opts: { reference?: { bytes: ArrayBuffer; name: string; mime: string }; temperature?: number; seed?: number }, deadlineMs: number): Promise<Voiceover> {
  const host = spaceHost();
  const pieces = splitScript(text);
  if (!pieces.length) throw new ToolError("text is empty.");
  const prompt = opts.reference ? await uploadReference(host, opts.reference.bytes, opts.reference.name, opts.reference.mime) : await defaultPrompt(host);
  const o: PieceOpts = { prompt, temperature: opts.temperature ?? 0.8, seed: opts.seed ?? 42 };
  const pcm: Pcm[] = [];
  for (const p of pieces) {
    if (Date.now() > deadlineMs) throw new ToolError(`Ran out of time after ${pcm.length} of ${pieces.length} pieces. Send the script in shorter parts (about 1,500 characters each).`);
    pcm.push(await generatePiece(host, p, o));
  }
  const { wav, offsets, seconds } = joinWav(pcm);
  return { wav, seconds, pieces: pieces.map((t, i) => ({ text: t, start: Math.round(offsets[i] * 100) / 100 })) };
}
