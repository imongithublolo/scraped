/**
 * Next.js instrumentation — runs once per server boot.
 *
 * NODE-SIDE FETCH FIX: this box's egress answers IPv4 but undici (node's
 * fetch engine) wedges on the IPv6 path — every outbound fetch to some
 * media instances ETIMEDOUTs while bun/browser fetches sail through.
 * Forcing the undici dispatcher onto IPv4 (family: 4) fixes the whole
 * server-side resolver chain. Browsers never run this file, and the bun
 * runtime is skipped entirely (its fetch has no such problem).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // bun's fetch is fine and doesn't know undici — node only. Reach for
  // process through globalThis: bundlers (edge targets) flag a bare
  // `process.versions` read as a Node API even behind the runtime guard.
  const proc = (globalThis as { process?: { versions?: Record<string, string | undefined> } }).process;
  const versions = proc?.versions;
  if (!versions || !versions["node"] || versions["bun"]) return;
  try {
    const { Agent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(
      new Agent({
        connect: { family: 4, timeout: 20_000 },
        headersTimeout: 25_000,
        bodyTimeout: 120_000,
      }),
    );
    console.log("[instrumentation] undici global dispatcher → IPv4");
  } catch (e) {
    console.error("[instrumentation] undici dispatcher setup failed:", e);
  }
}
