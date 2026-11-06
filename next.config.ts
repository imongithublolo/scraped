import type { NextConfig } from "next";
import { execSync } from "node:child_process";

/* Build identity: on Vercel this is the pushed commit; locally it's HEAD.
 * Surfaced in Settings → about so "did the deploy land?" is checkable
 * on-device instead of guesswork. */
const BUILD_SHA =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
  (() => {
    try {
      return execSync("git rev-parse --short HEAD").toString().trim();
    } catch {
      return "dev";
    }
  })();
const BUILD_TIME = process.env.VERCEL_GIT_COMMIT_TIMESTAMP
  ? new Date(process.env.VERCEL_GIT_COMMIT_TIMESTAMP).toISOString().slice(0, 16).replace("T", " ") + "z"
  : new Date().toISOString().slice(0, 16).replace("T", " ") + "z";

const nextConfig: NextConfig = {
  output: "standalone",
  /* The app is embedded cross-origin in the sandbox preview iframe
   * (preview-chat-*.space-z.ai). Without this, every /_next/* asset fetch
   * from that origin prints a dev-only cross-origin warning. */
  allowedDevOrigins: ["*.space-z.ai"],
  env: {
    NEXT_PUBLIC_BUILD_SHA: BUILD_SHA,
    NEXT_PUBLIC_BUILD_TIME: BUILD_TIME,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async headers() {
    return [
      {
        // Cross-origin isolation — required by the libcurl/wasm transport used
        // by the scramjet proxy stack. `credentialless` (not require-corp):
        // crossOriginIsolated / SharedArrayBuffer still activate in Chromium,
        // but cross-origin no-CORP embeds (the youtube live player in the
        // watch pane) load without credentials instead of being hard-blocked.
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
      {
        // THE MUSIC ENGINE'S WINDOW — /ytframe.html hosts youtube's IFrame
        // player. It used to ride COEP: unsafe-none, but that put it in a
        // DIFFERENT agent cluster than the isolated shell — and postMessage
        // across the cluster boundary never delivered (the shim's
        // ready/tick/error messages silently vanished: "music doesn't
        // work"). Matching the shell's COOP+COEP lands the shim in the
        // SAME cluster: full message flow. The youtube embed itself loads
        // fine under credentialless — cross-origin frames arrive
        // credential-stripped, not blocked (same as the watch pane's
        // live player).
        source: "/ytframe.html",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
      {
        // THE SERVICE WORKER MUST REVALIDATE — the offline mode, fault
        // pages and proxy fixes all live inside /sw.js. A cached worker
        // can outlive a deploy for a day (the browser's default update
        // check window), leaving users on the OLD offline page. no-cache
        // forces an instant revalidation on every site open.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
      {
        // the hub rip — it changes between deploys (footers, brand fixes);
        // no-cache keeps the landing page honest the moment a deploy lands
        source: "/hub/(.*)",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
      {
        // Vendored proxy client assets — NO long cache. These bundles get
        // patched between deploys (sw fixes, codec guards); an immutable
        // entry survives browser restarts and silently keeps a OLD bundle
        // alive under a NEW service worker — mismatched code, broken proxy.
        // must-revalidate keeps it cheap via ETag 304s.
        source: "/(scram|baremux|libcurl)/(.*)",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
