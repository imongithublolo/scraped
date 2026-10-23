# DAEMON OS

```
  ▄▌ ▄░▀    ▄▄░▀        ▄▌            ▄▄▄▄░▀          ▄▌  ░▀▌
▄▄▀▓▓▀█▒█▄▄██▀█▒█▄    ▄▄▀▓▓   █▄    ▄▄▓▓■▀▀▒▀▄      ▄▄▀▓▌  ▒▀▄▀   ▄▄░▓▀■▀▒▀▄
 █ ▒▌  ░ ▀██   ░ ▀█    █ ▒▌   ▌▀█    █ ▒▌  ░ ▐▌      █ ▒▌  ░ ▐▌    █ ▒▌  ░ ▐▌
 ▐▌░▌   ▌░▒▌    ▌░▒▌   ▐▌░▌   ▌░▒▌   ▐▌░▌  ▓ ░▒      ▐▌░▌  ▒ ▄▀    ▐▌░▌  ▓░░
  ░░▌   ■░░█    ■░░█    ░░▌   ■░░█   ▐░ ▌■▄▒▀▀       ▄░ ▄▄██▄       ░ ▌  ■▀
```

**A hellfire-red terminal that lives in a browser tab — no desktop, no
windows, just `dsh` fullscreen and a full Scramjet web proxy wired in.**

Themed around **red, BSD and the daemon**: brimstone boot ceremony with a
glowing sigil, film grain, a loading bar, Beastie in `neofetch`, and a
chrome-barred fullscreen shell. Apps take over the whole screen — the
terminal is the machine.

The entrance is a **blank black screen**. No logo, no input box, no hints.
You type the password blind and press Enter — and it's demanded **every
single time**, because nothing is ever stored: refresh, reopen, return from
another tab, and the gate is blank again.

---

## Features

| Area | Details |
| --- | --- |
| Shell | `dsh` fullscreen — 1.06s block-cursor blink, ghost-text tab completion, ↑/↓ history, `Ctrl+L`, `Ctrl+C`, sticky-bottom scrolling, chrome bar + status strip |
| Boot | short and quiet: sigil + film grain + block loading bar + three plain lines (any key skips) |
| Themes | `theme hell` / `amber` / `bone` — screen fades 200ms, phosphor swaps |
| CRT | scanlines (subtle), vignette, rolling beam — toggle with `crt` or by clicking **crt:on/off** in the chrome bar |
| Sound | **off by default**; opt-in mechanical-keyboard SFX (`sound on`) via WebAudio |
| File system | `ls` `cd` `cat` `mkdir` `rm -r` `touch` `echo >` `tree` `pwd` — persisted in `localStorage` |
| Browser | `proxy <url>` takes over the screen with a real Scramjet browser (toolbar, back/forward/reload, address bar, ✕ / alt+` returns to dsh) |
| Music | `play <song>` — 5 synthesized chiptunes from `~/music` (WebAudio sequencer) |
| Paint | `paint` — fullscreen 48×20 ASCII editor, brushes, undo, saves to `~/paintings` |
| Chat | `chat` — fullscreen fictional hacker-scene relay with personas, typing indicators, ambient messages |
| Weather | `weather <city>` — deterministic forecasts for cities that don't exist |
| Proxy | `proxy <url>` / `proxy status` / `proxy wisp <url>` — Scramjet over a Wisp relay |
| Neofetch | real vitals + Beastie: uptime, resolution, cores, memory, relay latency |
| Credits | `credits` — **b29s** and **GLM**, the developers <3 |
| Manual | `help` — full man(1)-style doc printed inline (scrollable); `help <cmd>` for one entry |
| Extras | `banner`, `murke`, `motd`, `history`, `whoami`, `date`, `sudo`, `exit` |

## The password gate

- The page renders **nothing** — a black screen with an invisible full-screen
  input. Type the password and press Enter.
- The password is verified **server-side** (`POST /api/auth`): the client ships
  zero password material. The server compares a salted SHA-256 digest
  (`sha256("murke-proxy::" + password)`) against `GATE_PASSWORD_HASH` using a
  timing-safe compare.
- **Nothing is stored.** No token, no session, no cookie. Every fresh page
  load starts from the blank gate — `exit` or a refresh and you're typing
  the password again.
- If the API is unreachable (e.g. a static mirror), a client-side digest check
  kicks in as a fallback.
- Default password: **`markX99`** — change it before you deploy (below).

## File structure

```
daemon-os/
├── src/
│   ├── app/
│   │   ├── page.tsx              # renders the shell
│   │   ├── layout.tsx            # black page, noindex metadata
│   │   ├── globals.css           # shell, boot, CRT styling
│   │   ├── api/auth/route.ts     # password check (stateless)
│   │   └── api/relay/route.ts    # dev-only relay keepalive (inert in prod)
│   ├── components/murke/
│   │   ├── MurkeOS.tsx           # gate → boot → shell state machine
│   │   ├── GateScreen.tsx        # the blank password screen
│   │   ├── BootScreen.tsx        # glowing logo + grain + loading bar
│   │   ├── Dsh.tsx               # the fullscreen terminal (hosts overlays)
│   │   ├── BrowserView.tsx       # fullscreen scramjet browser takeover
│   │   ├── MurkeArt.tsx          # auto-fitting sigil renderer
│   │   ├── PaintPane.tsx         # fullscreen ASCII paint editor
│   │   ├── ChatPane.tsx          # fullscreen fictional chat client
│   │   └── CrtOverlay.tsx        # scanlines / vignette / beam
│   └── lib/murke/
│       ├── contracts.ts          # shared types + storage keys
│       ├── commands.ts           # dsh command registry + man page
│       ├── vfs.ts                # virtual file system (shared instance)
│       ├── synth.ts              # chiptune engine + songs
│       ├── sound.ts              # mechanical key SFX (default off)
│       ├── weather.ts            # fake weather generator
│       ├── chatbot.ts            # chat personas + reply engine
│       ├── proxy.ts              # scramjet/baremux/wisp wiring + probing
│       ├── auth.ts               # stateless gate client
│       ├── themes.ts             # hell / amber / bone
│       └── murke-art.ts          # the sigil
├── public/
│   ├── scram/                    # vendored scramjet client (scramjet.all.js, .wasm)
│   ├── baremux/                  # vendored bare-mux connection + worker
│   ├── libcurl/                  # vendored libcurl-transport (wasm)
│   ├── sw.js                     # ScramjetServiceWorker registration
│   ├── config.js                 # ← set your wisp relay URL here
│   └── robots.txt
├── server/                       # ← THE PROXY BACKEND (deploy separately)
│   ├── index.mjs                 # wisp relay (single file, one dependency)
│   ├── package.json
│   └── README.md                 # deploy guide (Railway/Render/Fly/VPS)
├── scripts/hash-password.mjs     # generate GATE_PASSWORD_HASH
├── mini-services/wisp/           # sandbox dev runner for the relay
├── vercel.json                   # COOP/COEP headers (required by the transport)
├── next.config.ts
├── LICENSE
└── README.md
```

## Quick start (local)

```bash
git clone <your-fork> daemon-os
cd daemon-os
npm install        # or: bun install
npm run dev        # or: bun run dev
```

Open the app. Black screen. Type `markX99`, press Enter.

For a fully working proxy locally, run the relay in a second terminal:

```bash
cd server && npm install && npm start     # wisp relay on :3031
```

The frontend auto-detects a same-origin relay at `/wisp/`; for the dev port
setup you can point it explicitly:

```bash
# from the dsh terminal:
proxy wisp ws://localhost:3031/wisp/
proxy status
proxy example.com
```

## Deploying

### 1. The frontend → Vercel

1. Push this repo to GitHub (`.gitignore` already excludes logs/db/sandbox files).
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Framework preset: **Next.js** (auto-detected). No build flags needed —
   `vercel.json` already sets the COOP/COEP headers the wasm transport requires.
4. Set environment variables (Project → Settings → Environment Variables):

   | Variable | Value |
   | --- | --- |
   | `GATE_PASSWORD_HASH` | output of `node scripts/hash-password.mjs <new-password>` |
   | `SESSION_SECRET` | any long random string (`openssl rand -hex 32`) |

5. Deploy.

### 2. The wisp relay → anywhere that isn't Vercel

Vercel can't host the websocket relay, so `server/` deploys separately.
It's one file with one dependency — see **[server/README.md](server/README.md)**
for Railway / Render / Fly.io / VPS instructions.

### 3. Point the frontend at the relay

Any **one** of:

- edit `public/config.js` → `window.__DAEMON_CONFIG__ = { wisp: "wss://your-relay/wisp/" }`
- at runtime: `proxy wisp wss://your-relay/wisp/`
- reverse-proxy `/wisp/` on your frontend domain to the relay (zero config)

Verify with `proxy status`, then `proxy example.com`.

## Changing the password

```bash
node scripts/hash-password.mjs "my-new-password"
# → 5f8c3a…  (set this as GATE_PASSWORD_HASH in your host's env)
```

The default hash (for `markX99`) is baked in as a fallback so a fresh clone
works out of the box — **set the env var for anything real**.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS 4**
- **Scramjet 1.1.0** + **libcurl-transport** (wasm, E2E-encrypted) + **bare-mux**
- **wisp-js relay** (Node) — `server/`
- Zero database. Settings, files and history live in `localStorage`;
  auth lives nowhere at all.

## Notes

- `layout.tsx` sends `noindex` and the title is just `daemon` — the page stays
  quiet on shared hosting.
- The client-side gate fallback (used only when the API is unreachable) is
  inherently cosmetic; the server-side path is the real check.
- Keyboard/audio are **opt-in** and default to off.
- Released under the [MIT License](LICENSE).

---

Developed by **b29s** and **GLM** <3
