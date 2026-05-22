# Friday — Voice + Vision AI Assistant

A Jarvis-style web AI assistant powered by NVIDIA NIM. Drops into a blank Replit Node template and runs with `npm start`.

## Features

- Always-on wake word `Friday` until shutdown phrase `disconnect all systems`
- NVIDIA Riva voice in/out with Web Speech API fallback
- Barge-in: user speech interrupts ongoing TTS playback mid-sentence
- Text input + text output mirror voice
- 3D particle-hologram face (Three.js) with lip-sync and emotion expressions
- Camera mode with Iron-Man-style HUD overlay (brackets, scanning lines, reticles, holographic text)
- In-camera mini browser: voice "open google", "close web"
- Vision commands: product / medication / movement / material / math analysis
- VR split mode for Cardboard (button + voice toggle)
- Code generation panel — describe a goal, preview the result in a sandboxed iframe, download as ZIP
- Email+password auth (SQLite) with per-user chat & creation history

## Quick start

1. **Rotate any NVIDIA NIM keys you've shared publicly** at https://build.nvidia.com/, then store the new ones as secrets:
   - `NIM_KEY_REASONING` — chat LLM + Riva TTS/STT
   - `NIM_KEY_VISION` — vision model
   - `NIM_KEY_CODEGEN` — code generation model
   - `JWT_SECRET` — any long random string
2. On Replit: import this repo into a blank Node template, set the secrets above, hit **Run**.
3. Locally: `npm install && npm start`, open http://localhost:3000.

The project has **zero native dependencies** — everything is pure JS, so it
installs and runs on any Node 20+ environment without compilers or build
tools.

## Running on Replit when `.replit` / `replit.nix` were stripped

Replit's GitHub-import flow can strip hidden config files like `.replit`
and `replit.nix` for security. The project is built to run without them
— `package.json` has `main: "server.js"` and `scripts.start: "node
server.js"`, which Replit auto-detects.

If the Run button still does not work, recreate the two files manually
in your Replit workspace (use the "Show hidden files" toggle in the
file tree):

**`.replit`** (at the repo root):

```
run = "npm start"
entrypoint = "server.js"
modules = ["nodejs-20"]

[nix]
channel = "stable-23_11"

[[ports]]
localPort = 3000
externalPort = 80
```

**`replit.nix`** (at the repo root):

```
{ pkgs }: {
  deps = [ pkgs.nodejs_20 ];
}
```

That is the entire required config. There are no native deps, so no
`python3`, `gcc`, or `make` need to be declared.

After creating those files (or if Replit kept the originals from this
repo), open the Secrets tab and add the four env vars listed above.
Click Run.

### If the Run button does nothing

Most often this means Replit started before `npm install` finished, or
its auto-detect couldn't pick a launch command. Try in order:

1. Open the **Shell** tab and run:
   ```
   npm install
   node server.js
   ```
   If the server prints `Friday online at http://localhost:3000`, the
   Run button should also work on the next click — the issue was just
   missing `node_modules`.
2. If that works but the Run button still doesn't, recreate `.replit`
   per the snippet above. The repo's `.replit` has a `run = "npm
   install … && node server.js"` line so subsequent runs always
   verify deps before launching.
3. Both `index.js` (at the repo root) and `package.json`'s `main`
   point at the same entry, so any of `node .`, `node index.js`,
   `node server.js`, or `npm start` will boot the app.

## Architecture

```
server.js                Express boot
server/
  db.js  middleware.js  auth.js  prompts.js
  chat.js  vision.js  codegen.js  voice.js
public/
  index.html  login.html  styles.css
  assets/face-landmarks.json
  js/
    api.js  auth.js  app.js
    wake.js  voice.js  barge.js
    face.js  hud.js
    camera.js  miniBrowser.js  vr.js
    codegen.js
data/friday.db           (created at first run)
```

All NVIDIA NIM calls go through server-side proxies — the three keys never reach the browser.

## Voice commands

- "Friday" — wake word, starts a fresh listening turn
- "disconnect all systems" — shuts the voice loop down
- "camera mode" / "exit camera" — toggle vision HUD
- "vr mode" / "exit vr" — toggle stereoscopic VR
- "analyze product / medication / movement / material / math" — vision commands inside camera mode
- "open google" (or duckduckgo, bing) — translucent in-HUD browser
- "close web" — dismiss the mini browser

## Notes

- The browser must be Chromium-based for full Web Speech API fallback support.
- Camera + mic require HTTPS in production. Replit serves HTTPS by default.
- The first run will create `data/friday.db` automatically.
