// DAEMON client configuration.
//
// Pin a proxy transport here if you never want the auto-probe to decide:
//
//   window.__DAEMON_CONFIG__ = { wisp: "wss://your-wisp-host.example/wisp/" };
//   window.__DAEMON_CONFIG__ = { relay: "https://your-relay-host.example/api/relay" };
//
// `wisp` wins for wisp:// / ws(s):// urls, `relay` for http(s) urls. Leave
// both empty for the built-in auto-probe: same-origin /api/relay first
// (validated with a real forward), then the sandbox gateway wisp relay,
// then the public mercury workshop wisp server. You can also override at
// runtime from the terminal:  proxy wisp wss://host/wisp/
window.__DAEMON_CONFIG__ = window.__DAEMON_CONFIG__ || { wisp: "", relay: "" };
