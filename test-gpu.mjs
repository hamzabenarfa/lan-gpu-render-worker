// test-gpu.mjs — Verify NVIDIA GPU, FFmpeg h264_nvenc, and headless Chrome WebGL (ANGLE D3D11)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function findBrowser() {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

console.log("=== 1) NVIDIA GPU (nvidia-smi) ===");
const smi = spawnSync(
  "nvidia-smi",
  ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
  { encoding: "utf8" },
);
if (smi.status === 0) {
  console.log("OK:", smi.stdout.trim());
} else {
  console.error("FAIL: nvidia-smi not available:", (smi.stderr || smi.error?.message || "").trim());
}

console.log("\n=== 2) FFmpeg h264_nvenc probe ===");
const ffmpeg = process.env.FFMPEG || "ffmpeg";
const nvenc = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=640x360:r=30",
    "-frames:v",
    "5",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "h264_nvenc",
    "-preset",
    "p7",
    "-tune",
    "hq",
    "-rc",
    "vbr",
    "-cq",
    "20",
    "-b:v",
    "0",
    "-spatial-aq",
    "1",
    "-temporal-aq",
    "1",
    "-rc-lookahead",
    "32",
    "-bf",
    "3",
    "-b_ref_mode",
    "middle",
    "-f",
    "null",
    "-",
  ],
  { encoding: "utf8", timeout: 20000 },
);
if (nvenc.status === 0) {
  console.log("OK: h264_nvenc encode succeeded");
} else {
  console.error("FAIL: h264_nvenc failed:", (nvenc.stderr || nvenc.error?.message || "").trim());
}

console.log("\n=== 3) Headless Chrome WebGL GPU check ===");
const exe = findBrowser();
if (!exe) {
  console.error("FAIL: Chrome/Edge executable not found (set CHROME env var)");
  process.exit(1);
}
console.log("Browser:", exe);

const puppeteer = require("puppeteer-core");
const glFlags =
  process.platform === "win32"
    ? ["--enable-gpu", "--use-gl=angle", "--use-angle=d3d11", "--ignore-gpu-blocklist"]
    : fs.existsSync("/dev/dri/renderD128")
      ? ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist"]
      : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: "new",
  args: glFlags,
});
try {
  const page = await browser.newPage();
  const info = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return { ok: false, renderer: "NO_WEBGL2" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return { ok: !/swiftshader|llvmpipe|basic render/i.test(String(renderer)), renderer: String(renderer) };
  });
  console.log("WebGL Renderer:", info.renderer);
  if (info.ok) {
    console.log("OK: Hardware GPU WebGL is active");
  } else {
    console.error("WARN: Software WebGL detected! Make sure you run this in a logged-in desktop session (not SSH Session 0).");
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
