/*  Downloader backend: Express + yt-dlp + ffmpeg
 *
 *  Setup:
 *    1. Install yt-dlp and ffmpeg on the server and make sure both are on PATH
 *         pip install -U yt-dlp      (or download the binary)
 *         apt install ffmpeg
 *    2. npm i express cors
 *    3. node server.js            (listens on :5000)
 *    4. Frontend: set VITE_API_URL=http://localhost:5000/api
 *       (or proxy /api to this server in vite.config.js)
 *
 *  Keep yt-dlp updated (yt-dlp -U); platforms change often.
 *  Add `--cookies cookies.txt` to the args if you need logged-in content.
 */
import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const app = express();
app.set("trust proxy", 1);
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || true,
  exposedHeaders: ["Content-Disposition", "Content-Length"],
}));

const PORT = process.env.PORT || 5000;
const MAX_FILE_MB = 1024; // refuse anything bigger than ~1 GB
const HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
const AUDIO = [
  { id: "mp3-320", label: "MP3 320 kbps", ext: "mp3", fmt: "mp3", q: "320K" },
  { id: "mp3-192", label: "MP3 192 kbps", ext: "mp3", fmt: "mp3", q: "192K" },
  { id: "mp3-128", label: "MP3 128 kbps", ext: "mp3", fmt: "mp3", q: "128K" },
  { id: "m4a", label: "M4A best", ext: "m4a", fmt: "m4a", q: "0" },
];

/* ---- tiny per-IP rate limiter (swap for express-rate-limit in production) ---- */
const hits = new Map();
app.use("/api", (req, res, next) => {
  const now = Date.now(), k = req.ip, arr = (hits.get(k) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(k, arr);
  if (arr.length > 30) return res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
  next();
});

const safeUrl = (s) => {
  try { const u = new URL(String(s)); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
};

const run = (args, { timeout = 60000 } = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Timed out")); }, timeout);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => { clearTimeout(t); reject(new Error("yt-dlp is not installed on the server.")); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(err.split("\n").filter(Boolean).pop() || "yt-dlp failed")); });
  });

const friendly = (m = "") => {
  console.error("yt-dlp error:", m);
  return /private|login|sign in|cookies/i.test(m) ? "This video is private or needs a login."
    : /unsupported url/i.test(m) ? "This site or link isn't supported."
    : /not available|removed|unavailable|404/i.test(m) ? "This video is unavailable or was removed."
    : /not installed/i.test(m) ? m
    : "We couldn't read this link. Check the URL and try again.";
};
/* ------------------------------------ info ------------------------------------ */
app.get("/api/info", async (req, res) => {
  const url = safeUrl(req.query.url);
  if (!url) return res.status(400).json({ error: "Invalid link." });
  try {
    const j = JSON.parse(await run(["-J", "--no-playlist", "--no-warnings", "--", url]));
    const fs = j.formats || [];
    const have = new Set(fs.filter((f) => f.vcodec && f.vcodec !== "none").map((f) => f.height).filter(Boolean));
    const video = HEIGHTS.filter((h) => have.has(h)).map((h) => {
      const best = fs.filter((f) => f.height === h && f.vcodec !== "none").sort((a, b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0))[0];
      return { id: String(h), label: `${h}p`, ext: "mp4", size: best?.filesize || best?.filesize_approx || undefined };
    });
    if (!video.length && fs.some((f) => f.vcodec && f.vcodec !== "none")) video.push({ id: "best", label: "Best available", ext: "mp4" });
    const hasAudio = fs.some((f) => f.acodec && f.acodec !== "none");
    res.json({
      title: j.title, thumbnail: j.thumbnail, duration: j.duration, uploader: j.uploader || j.channel,
      platform: j.extractor_key, video,
      audio: hasAudio ? AUDIO.map(({ id, label, ext }) => ({ id, label, ext })) : [],
    });
  } catch (e) {
    res.status(422).json({ error: friendly(e.message) });
  }
});

/* ---------------------------------- download ---------------------------------- */
app.get("/api/download", async (req, res) => {
  const url = safeUrl(req.query.url);
  const type = req.query.type === "audio" ? "audio" : "video";
  const id = String(req.query.id || "");
  if (!url) return res.status(400).json({ error: "Invalid link." });

  const args = ["--no-playlist", "--no-warnings", "--max-filesize", `${MAX_FILE_MB}M`, "-o", "%(title).80s.%(ext)s", "--restrict-filenames"];
  if (type === "audio") {
    const a = AUDIO.find((x) => x.id === id);
    if (!a) return res.status(400).json({ error: "Unknown audio format." });
    args.push("-f", "bestaudio/best", "-x", "--audio-format", a.fmt, "--audio-quality", a.q);
  } else {
    const h = Number(id);
    const sel = id === "best" ? "bv*+ba/b" : HEIGHTS.includes(h) ? `bv*[height<=${h}]+ba/b[height<=${h}]/b` : null;
    if (!sel) return res.status(400).json({ error: "Unknown quality." });
    args.push("-f", sel, "--merge-output-format", "mp4");
  }

  let dir;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "dl-"));
    const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
    const p = spawn("yt-dlp", [...args, "--", url], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    res.on("close", () => { if (!res.writableEnded) p.kill("SIGKILL"); });

    p.on("error", () => { cleanup(); res.status(500).json({ error: "yt-dlp is not installed on the server." }); });
    p.on("close", async (code) => {
      try {
        const files = (await readdir(dir)).filter((f) => !f.endsWith(".part") && !f.endsWith(".ytdl"));
        if (code !== 0 || !files.length) throw new Error(err);
        const file = path.join(dir, files[0]);
        const { size } = await stat(file);
        res.setHeader("Content-Length", size);
        res.download(file, files[0], () => cleanup());
      } catch (e) {
        cleanup();
        if (!res.headersSent) res.status(422).json({ error: /larger than/i.test(e.message) ? "This file is too large to download here." : friendly(e.message) });
      }
    });
  } catch {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

app.listen(PORT, () => console.log(`Downloader API on :${PORT}`));
