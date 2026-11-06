# frost

A web desktop that lives in a browser tab. One page, no installs.

The entrance is an ordinary-looking site. The konami code
(**↑ ↑ ↓ ↓ ← → ← → B A**) summons a single glass capsule — type the
password and the desktop fades in. Nothing is stored: refresh, and the
gate is back.

## What's in it

- **Home** — a wallpaper, a glass search bar, and widgets you place
  yourself: clocks (any Google Font, any timezone — glass letters for the
  frost face, plain type for everything else), weather, notes, text,
  battery, music, oneko.
- **Editor** — press the pencil: drag, resize and delete widgets, add new
  ones from the text-only palette, snap to grid. The layout survives
  reloads.
- **Frost engine** — search from the home bar; results float as glass
  cards on a frosted panel over a live water shader (three.js), with a
  soft ice-glow hover.
- **Browser** — a real proxied web browser in tabs (Scramjet), with a
  tabs rail, omnibox and a carousel of live pages.
- **The rest** — boot screen, settings (wallpaper, glass, search bar),
  PWA install.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Prisma (SQLite) ·
Scramjet + baremux + epoxy/httpx transports · wisp-js relay · three.js
(the results-page water).

## Run it

```bash
bun install
bun run dev        # http://localhost:3000
```

The wisp relay (optional, for the sandbox) runs as a mini-service:

```bash
cd mini-services/wisp && bun run dev   # :3031
```

## Password

The gate checks a salted SHA-256 server-side
(`sha256("murke-proxy::" + password)`). Change it with:

```bash
node scripts/hash-password.mjs "my-new-password"
# set GATE_PASSWORD_HASH (env) or the admin app's site store to the output
```

The built-in default ships in `src/app/api/auth/route.ts`.

## Deploy

The frontend deploys to Vercel (git-integrated — push to `main`).
`vercel.json` carries the COOP/COEP headers the wasm transports need.
The wisp relay (`server/`) is a separate service for any host that
allows persistent websockets — see `server/README.md`.

Env vars worth setting in production:

| Variable | Value |
| --- | --- |
| `GATE_PASSWORD_HASH` | output of `scripts/hash-password.mjs` |
| `SESSION_SECRET` | any long random string |
| `GITHUB_TOKEN` | backs the site store / chat history (GitHub Contents) |

## Notes

- `layout.tsx` sends `noindex`; the page stays quiet.
- Proxy transports are probed in order: same-origin relay (`/api/relay`,
  real end-to-end forward check) → wisp. Pin one in `public/config.js` or
  with `proxy wisp <url>`.
- MIT licensed.
