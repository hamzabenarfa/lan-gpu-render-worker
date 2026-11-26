# LAN GPU Render Worker (Windows NVIDIA GPU + Linux Laptop)

Offload heavy headless Chrome WebGL (3D) + FFmpeg NVENC video renders from a Linux laptop to a Windows desktop PC with an NVIDIA GPU (such as a GTX 1080 Ti) on the same local network.

## Why Native Windows (Not WSL2, Not OpenSSH)

- **Do not use WSL2 for Chrome 3D rendering.** WSL2 does not expose your NVIDIA GPU to Linux Chrome for WebGL. Chrome silently falls back to SwiftShader (CPU rendering).
- **Do not launch Chrome GPU renders from Windows OpenSSH.** Windows OpenSSH runs in `Session 0` (a non-interactive service session with no display access), where Direct3D 11 WebGL fails or falls back to CPU.
- **Native Windows HTTP worker solves both.** Running `worker.mjs` inside your normal logged-in Windows desktop session gives headless Chrome full ANGLE Direct3D 11 access to the GPU and gives FFmpeg full `h264_nvenc` hardware encoding.

## Files

| File | Runs on | Purpose |
|---|---|---|
| `setup-render-pc.ps1` | Windows PC (Admin PowerShell) | Installs Node.js, FFmpeg, Chrome, and `puppeteer-core`, opens firewall port `8787` on your LAN only, creates `.token`, and tests the GPU |
| `test-gpu.mjs` | Windows PC | Verifies `nvidia-smi`, `h264_nvenc` encoding, and Chrome WebGL hardware GPU rendering |
| `worker.mjs` | Windows PC | Local LAN HTTP render server (patches Linux-only `/dev/dri/renderD128` checks in `render.js` to Windows ANGLE D3D11 automatically) |
| `start-worker.bat` | Windows PC | Double-click launcher for `worker.mjs` |
| `remote-render.sh` | Linux laptop | Packs `films/<id>/`, uploads to the Windows PC, streams render logs, and downloads `films/<id>/render/<id>.mp4` |

---

## Step 1: One-Time Setup on the Windows Desktop PC

1. Install the latest NVIDIA driver that supports your GPU.
2. In **Windows Settings → Network & Internet**, set your LAN/Wi-Fi profile to **Private**.
3. In **Windows Settings → System → Power**, set the PC to **Never sleep** when plugged in.
4. Open **PowerShell as Administrator** and run this single setup command:

```powershell
git clone https://github.com/hamzabenarfa/lan-gpu-render-worker.git; cd lan-gpu-render-worker; powershell -ExecutionPolicy Bypass -File .\setup-render-pc.ps1
```

The script installs all tools, adds a Windows Startup shortcut so the worker runs automatically on every boot, verifies the GTX 1080 Ti, and starts the worker immediately.

Confirm that the GPU check prints:
- `OK: h264_nvenc encode succeeded`
- `WebGL Renderer: ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti ...)` (not `SwiftShader`)

Copy the two lines printed at the end (`RENDER_HOST` and `RENDER_TOKEN`) into `.env` on your Linux laptop.

---

## Step 2: Keep Running (Automatic After Setup)

`setup-render-pc.ps1` already starts the worker and adds `LAN-GPU-Render-Worker.lnk` to Windows Startup (`shell:startup`). To start it manually anytime, double-click **`start-worker.bat`** or run `node worker.mjs`.

- Stay signed into Windows while rendering. Do not lock the screen with `Win+L`, because locking Windows can pause Direct3D 11 WebGL rendering.
- Default concurrency is `WK=4` workers (safe under the NVIDIA consumer NVENC session limit). Override with `$env:WK="2"; node worker.mjs` if you want lower VRAM use.

---

## Step 3: Render From Your Linux Laptop

Set your desktop PC address and token (in your shell or in your project's `.env`):

```bash
export RENDER_HOST="http://<DESKTOP_LAN_IP>:8787"
export RENDER_TOKEN="<TOKEN_FROM_WINDOWS_SETUP>"
```

Run `remote-render.sh` from your project root after exporting the film folder (`films/<id>/`):

```bash
# 1. Export the self-contained film folder on your laptop
just make specs/<id>.json --only validate,tts,captions,mix,export

# 2. Render on the Windows desktop GPU and save films/<id>/render/<id>.mp4
/path/to/lan-gpu-render-worker/remote-render.sh specs/<id>.json 4

# 3. Continue QA, score, and delivery on your laptop
just qa specs/<id>.json
just make specs/<id>.json --only score,deliver
```

You can also pass explicit flags without a spec file:

```bash
./remote-render.sh --film-dir films/my-video --id my-video --dur 60 --wk 4
```

### 16:9 Chapters

```bash
bun run pipeline/cli/export-film.ts --aspect 16x9 specs/<chapter>.json
/path/to/lan-gpu-render-worker/remote-render.sh specs/<chapter>.json 4
cp films/<id>/render/<id>.mp4 renders/<id>/<id>-16x9.mp4
just qa --aspect 16x9 specs/<chapter>.json
```

---

## Notes for GTX 1080 Ti (Pascal)

- **NVENC (`h264_nvenc`):** Pascal supports `-bf 3 -b_ref_mode middle`, `-spatial-aq 1`, and `-temporal-aq 1`. Avoid `-b_ref_mode each` (Turing+ only).
- **Whisper (`faster-whisper` on CUDA):** If you also run `faster-whisper` on a GTX 1080 Ti (CUDA compute capability `6.1`), use `device="cuda"` with `compute_type="int8"` (or `"float32"`). Avoid `float16` because Pascal cards do not have FP16 Tensor Cores.
- **Full desktop control:** If you want to run full CLI commands directly on the desktop PC instead of HTTP offloading, use **RustDesk** or **Parsec** rather than headless SSH so your interactive GPU session stays active.

---

## Troubleshooting

- **Cannot reach `http://<IP>:8787/health` from laptop:** Check that Windows network profile is **Private** (not Public), and re-run `setup-render-pc.ps1 -SkipWinget` to refresh the firewall rule.
- **WebGL prints `SwiftShader`:** You launched the script from SSH (`Session 0`) or a locked desktop. Run `node test-gpu.mjs` inside a normal logged-in Windows desktop terminal.
- **Check health manually from Linux:**
  ```bash
  curl http://<DESKTOP_LAN_IP>:8787/health
  ```
