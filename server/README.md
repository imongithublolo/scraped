# murke-wisp-relay

The **backend** of MURKE Proxy. Scramjet runs in the visitor's browser (vendored
into the Next.js app), but its traffic has to ride a **wisp relay** — a
websocket server that opens real TCP connections to destination sites.

Vercel cannot host persistent websocket servers, so this component deploys
separately. It is a single file with one dependency.

## Run locally

```bash
npm install
npm start          # listens on 0.0.0.0:3031 (override with PORT / HOST)
```

Health check: `curl http://localhost:3031/health`

## Environment

| Variable              | Default               | Purpose                                   |
| --------------------- | --------------------- | ----------------------------------------- |
| `PORT`                | `3031`                | listen port                               |
| `HOST`                | `0.0.0.0`             | listen address                            |
| `WISP_UDP`            | `0`                   | `1` enables UDP streams (QUIC/HTTP3)      |
| `WISP_ALLOW_PRIVATE`  | `0`                   | `1` allows private-IP destinations (risky)|
| `WISP_ALLOW_LOOPBACK` | `0`                   | `1` allows loopback destinations          |
| `WISP_DNS`            | `1.1.1.3,1.0.0.3`     | comma-separated upstream DNS servers      |

## Deploy (pick one)

**Railway** — new project → Deploy from GitHub → set root directory to `server/`
→ Railway auto-detects `npm start`. Copy the public URL.

**Render** — New Web Service → root directory `server/` → build `npm install`
→ start `npm start`.

**Fly.io** — `fly launch --no-deploy` inside `server/`, then `fly deploy`.
Use a `tcp` service on port 3031, or put it behind their HTTP router —
wisp is plain websocket-over-HTTP, so the standard `http_service` works.

**Any VPS** — `npm i && PORT=443 node index.mjs` behind Caddy/nginx for TLS:

```caddy
wisp.yourdomain.com {
    reverse_proxy /wisp/* localhost:3031
}
```

## Wire the frontend to it

Once deployed (say `https://wisp.yourdomain.com`), do **one** of:

1. Edit `public/config.js` in the frontend repo:

   ```js
   window.__MURKE_CONFIG__ = { wisp: "wss://wisp.yourdomain.com/wisp/" };
   ```

2. Or set it at runtime from the murke terminal:

   ```
   proxy wisp wss://wisp.yourdomain.com/wisp/
   ```

3. Or reverse-proxy `/wisp/` on the frontend's own domain to the relay, and the
   auto-detection picks it up with zero config.

Verify from the terminal with `proxy status`.
