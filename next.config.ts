import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
