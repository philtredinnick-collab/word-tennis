/* Word Tennis clip relay — zero dependencies, plain Node.
 *
 * The only thing this server exists to do is move a video clip from one phone to
 * the other WITHOUT it ever becoming a file the receiver can open early. So:
 *
 *   - the sender uploads the clip and gets back a short id
 *   - the id travels inside the ordinary turn link (a few characters)
 *   - the receiver CANNOT download it until they have posted a guess
 *   - after they watch and continue, the clip is deleted for good
 *
 * It also serves the game itself from ./public, so both players are on one
 * origin and there is nothing to configure.
 *
 * Run:  node index.js       (PORT env optional, default 8080)
 */

import { createServer } from "node:http";
import { readFile, writeFile, unlink, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const CLIPS = join(here, "data", "clips");
const INDEX = join(here, "data", "clips.json");
const PUBLIC = join(here, "public");

const MAX_CLIP = 40 * 1024 * 1024;          // a 60s phone clip is far under this
const TTL_MS = 48 * 60 * 60 * 1000;         // unwatched clips die after two days
const PORT = process.env.PORT || 8080;

await mkdir(CLIPS, { recursive: true });

/* clip id -> { type, guess, unlocked, at } — small enough to keep in memory */
let meta = {};
try { meta = JSON.parse(await readFile(INDEX, "utf8")); } catch {}
let saveTimer = null;
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFile(INDEX, JSON.stringify(meta)).catch(() => {}), 300);
};

const newId = () => randomBytes(9).toString("base64url");
const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...cors });
  res.end(JSON.stringify(obj));
};
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,x-wt-type"
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("too big")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".webm": "video/webm"
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^([/\\.])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error("dir");
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "content-length": st.size });
    createReadStream(file).pipe(res);
  } catch {
    // single-page game: anything unknown falls back to it, so a stray path still plays
    try {
      const html = await readFile(join(PUBLIC, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"], "content-length": html.length }).end(html);
    } catch { json(res, 404, { error: "not found" }); }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  if (p === "/api/health") return json(res, 200, { ok: true, clips: Object.keys(meta).length });

  /* 1. sender uploads a clip -> id */
  if (p === "/api/clips" && req.method === "POST") {
    let buf;
    try { buf = await readBody(req, MAX_CLIP); } catch { return json(res, 413, { error: "clip too large" }); }
    if (!buf.length) return json(res, 400, { error: "empty clip" });
    const id = newId();
    await writeFile(join(CLIPS, id), buf);
    meta[id] = { type: String(req.headers["x-wt-type"] || "video/webm").slice(0, 40), unlocked: false, guess: "", at: Date.now() };
    persist();
    return json(res, 200, { id, bytes: buf.length });
  }

  const m = p.match(/^\/api\/clips\/([A-Za-z0-9_-]{4,32})(\/unlock)?$/);
  if (m) {
    const id = m[1], isUnlock = !!m[2], rec = meta[id];

    /* 2. the guess is what buys the clip. No guess, no video. */
    if (isUnlock && req.method === "POST") {
      if (!rec) return json(res, 404, { error: "clip is gone" });
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}"); } catch {}
      const guess = String(body.guess || "").slice(0, 80).trim();
      if (!guess) return json(res, 400, { error: "a guess is required first" });
      rec.unlocked = true; rec.guess = guess; rec.at = Date.now();
      persist();
      return json(res, 200, { ok: true });
    }

    /* 3. the gated download */
    if (req.method === "GET") {
      if (!rec) return json(res, 404, { error: "clip is gone" });
      if (!rec.unlocked) return json(res, 403, { error: "lock in a guess first" });
      try {
        const st = await stat(join(CLIPS, id));
        res.writeHead(200, { "content-type": rec.type, "content-length": st.size, "cache-control": "no-store", ...cors });
        createReadStream(join(CLIPS, id)).pipe(res);
      } catch { return json(res, 404, { error: "clip is gone" }); }
      return;
    }

    /* 4. watched and moved on -> destroy it */
    if (req.method === "DELETE") {
      delete meta[id]; persist();
      await unlink(join(CLIPS, id)).catch(() => {});
      return json(res, 200, { ok: true });
    }
  }

  if (p.startsWith("/api/")) return json(res, 404, { error: "no such endpoint" });
  return serveStatic(req, res, p);
});

/* housekeeping: nothing lingers */
setInterval(async () => {
  const t = Date.now();
  for (const [id, rec] of Object.entries(meta)) {
    if (t - rec.at > TTL_MS) { delete meta[id]; await unlink(join(CLIPS, id)).catch(() => {}); }
  }
  persist();
  try {
    for (const f of await readdir(CLIPS)) if (!meta[f]) await unlink(join(CLIPS, f)).catch(() => {});
  } catch {}
}, 30 * 60 * 1000);

server.listen(PORT, "0.0.0.0", () => console.log("Word Tennis relay on :" + PORT));
