// worker.mjs — LAN HTTP render worker for offloading film renders to a Windows NVIDIA GPU PC
// Run inside a normal logged-in Windows PowerShell window (not SSH Session 0):
//   node worker.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(WORKER_DIR, "jobs");
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_WK = Number(process.env.WK || 4); // GTX 1080 Ti handles 4 parallel workers smoothly
const MAX_WK = Number(process.env.MAX_WK || 6);
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // Auto-clean finished jobs after 6 hours

function loadToken() {
  if (process.env.RENDER_TOKEN) return process.env.RENDER_TOKEN.trim();
  const tokenFile = path.join(WORKER_DIR, ".token");
  if (!fs.existsSync(tokenFile)) {
    const generated = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(tokenFile, generated, "utf8");
    console.log(`Generated new token in ${tokenFile}`);
    return generated;
  }
  return fs.readFileSync(tokenFile, "utf8").trim();
}

const TOKEN = loadToken();
fs.mkdirSync(JOBS_DIR, { recursive: true });

const jobs = new Map();
const queue = [];
let busy = false;

// Patch Linux-only /dev/dri/renderD128 check in incoming render.js so Windows uses ANGLE D3D11 on the GPU
const CROSS_PLATFORM_GL_FN = `function glArgs() {
  if (process.env.RENDER_GL === "swiftshader")
    return ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  if (process.platform === "win32")
    return ["--enable-gpu", "--use-gl=angle", "--use-angle=d3d11", "--ignore-gpu-blocklist"];
  if (fs.existsSync("/dev/dri/renderD128"))
    return ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist"];
  return ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
}`;

function patchRenderForWindows(renderJsPath) {
  if (!fs.existsSync(renderJsPath)) return;
  const src = fs.readFileSync(renderJsPath, "utf8");
  const patched = src.replace(/function glArgs\(\)\s*\{[\s\S]*?\n\}/, CROSS_PLATFORM_GL_FN);
  if (patched !== src) fs.writeFileSync(renderJsPath, patched, "utf8");
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {}
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status === "running" || job.status === "queued") continue;
    if (job.finishedMs && now - job.finishedMs > JOB_TTL_MS) {
      fs.rmSync(job.dir, { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}
setInterval(cleanupOldJobs, 30 * 60 * 1000).unref();

function runNext() {
  if (busy || queue.length === 0) return;
  const job = queue.shift();
  busy = true;
  job.status = "running";
  job.startedAt = new Date().toISOString();

  const filmDir = path.join(job.dir, job.filmId);
  fs.mkdirSync(filmDir, { recursive: true });

  try {
    // Windows 10/11 ships with bsdtar at System32\tar.exe; Linux/macOS ship with tar
    execFileSync("tar", ["-xzf", job.archive, "-C", filmDir], { stdio: "pipe" });
    const pkgPath = path.join(filmDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({ name: job.filmId, private: true }) + "\n", "utf8");
    }
    patchRenderForWindows(path.join(filmDir, "render.js"));
  } catch (err) {
    job.status = "failed";
    job.error = `extract failed: ${err.message}`;
    job.finishedAt = new Date().toISOString();
    job.finishedMs = Date.now();
    busy = false;
    runNext();
    return;
  }

  const renderScript = path.join(filmDir, "render.js");
  if (!fs.existsSync(renderScript)) {
    job.status = "failed";
    job.error = "archive does not contain render.js";
    job.finishedAt = new Date().toISOString();
    job.finishedMs = Date.now();
    busy = false;
    runNext();
    return;
  }

  const child = spawn(process.execPath, ["render.js", String(job.workers)], {
    cwd: filmDir,
    env: {
      ...process.env,
      DUR: String(job.dur),
      WK: String(job.workers),
      MIJHAR_ROOT: WORKER_DIR,
      RENDER_ENCODER: job.encoder || process.env.RENDER_ENCODER || "auto",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let finishedByLine = false;
  let graceTimer = null;

  const onChunk = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      job.logs.push(line);
      if (job.logs.length > 500) job.logs.shift();
      console.log(`[${job.id}] ${line}`);
      if (!finishedByLine && /^done \d+s$/.test(line.trim())) {
        finishedByLine = true;
        graceTimer = setTimeout(() => killTree(child.pid), 10_000);
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("error", (err) => {
    if (graceTimer) clearTimeout(graceTimer);
    job.status = "failed";
    job.error = `spawn failed: ${err.message}`;
    job.finishedAt = new Date().toISOString();
    job.finishedMs = Date.now();
    busy = false;
    runNext();
  });

  child.on("close", (code) => {
    if (graceTimer) clearTimeout(graceTimer);
    const withAudio = path.join(filmDir, "render", `${job.filmId}.mp4`);
    const silent = path.join(filmDir, "render", "video.mp4");
    const outMp4 = fs.existsSync(withAudio) ? withAudio : fs.existsSync(silent) ? silent : null;

    if ((code === 0 || finishedByLine) && outMp4) {
      job.status = "done";
      job.output = outMp4;
    } else {
      job.status = "failed";
      job.error = outMp4 ? `render exited ${code}` : `render exited ${code} with no output mp4`;
    }
    job.finishedAt = new Date().toISOString();
    job.finishedMs = Date.now();
    busy = false;
    runNext();
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        platform: process.platform,
        busy,
        queued: queue.length,
        defaultWorkers: DEFAULT_WK,
      });
    }

    const headerToken = String(req.headers["x-render-token"] || "");
    const expected = Buffer.from(TOKEN);
    const given = Buffer.from(headerToken);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    // POST /jobs?id=<filmId>&dur=<sec>&wk=<workers>&encoder=<auto|nvenc|x264>
    if (req.method === "POST" && url.pathname === "/jobs") {
      const filmId = url.searchParams.get("id") || "";
      const dur = Number(url.searchParams.get("dur") || 0);
      const workers = Math.max(1, Math.min(MAX_WK, Number(url.searchParams.get("wk") || DEFAULT_WK)));
      const encoder = url.searchParams.get("encoder") || "";
      if (!/^[a-zA-Z0-9._-]+$/.test(filmId) || !(dur > 0)) {
        return sendJson(res, 400, { error: "valid id and dur (> 0) required" });
      }
      if (encoder && !/^(auto|nvenc|amf|qsv|vaapi|videotoolbox|x264)$/.test(encoder)) {
        return sendJson(res, 400, { error: "invalid encoder" });
      }

      const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
      const dir = path.join(JOBS_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      const archive = path.join(dir, "film.tar.gz");
      await pipeline(req, fs.createWriteStream(archive));

      const job = { id, filmId, dur, workers, encoder, dir, archive, status: "queued", logs: [] };
      jobs.set(id, job);
      queue.push(job);
      runNext();

      return sendJson(res, 202, { jobId: id, status: job.status });
    }

    // GET /jobs/<id>
    const statusMatch = /^\/jobs\/([a-z0-9-]+)$/.exec(url.pathname);
    if (req.method === "GET" && statusMatch) {
      const job = jobs.get(statusMatch[1]);
      if (!job) return sendJson(res, 404, { error: "job not found" });
      return sendJson(res, 200, {
        jobId: job.id,
        filmId: job.filmId,
        status: job.status,
        error: job.error || null,
        logs: job.logs,
      });
    }

    // GET /jobs/<id>/video.mp4
    const dlMatch = /^\/jobs\/([a-z0-9-]+)\/video\.mp4$/.exec(url.pathname);
    if (req.method === "GET" && dlMatch) {
      const job = jobs.get(dlMatch[1]);
      if (!job || job.status !== "done" || !job.output || !fs.existsSync(job.output)) {
        return sendJson(res, 404, { error: "video not ready" });
      }
      const st = fs.statSync(job.output);
      res.writeHead(200, { "content-type": "video/mp4", "content-length": st.size });
      return fs.createReadStream(job.output).pipe(res);
    }

    // DELETE /jobs/<id>
    const delMatch = /^\/jobs\/([a-z0-9-]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && delMatch) {
      const job = jobs.get(delMatch[1]);
      if (job && job.status !== "running") {
        fs.rmSync(job.dir, { recursive: true, force: true });
        jobs.delete(job.id);
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error("Request error:", err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LAN GPU render worker listening on http://0.0.0.0:${PORT}`);
  console.log(`Worker dir: ${WORKER_DIR} | Default workers: ${DEFAULT_WK}`);
});
