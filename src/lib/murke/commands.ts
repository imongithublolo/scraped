import type { CommandContext, CommandDef } from "./contracts";
import { NEWTAB_URL } from "./contracts";
import { MURKE_ART_HTML, MURKE_BANNER, MURKE_NEOFETCH_HTML, MURKE_DEMON_ROWS_HTML, MURKE_DEMON_TEXT, MURKE_DEMON_WIDTH, themeArt } from "./murke-art";
import { fetchUserGeo, fetchWeather, renderWeatherHTML, weatherCardAttrs } from "./weather";
import { THEMES, THEME_ORDER, isThemeName } from "./themes";
import { fetchIntoVfs, formatBytes } from "./fetch-file";

/**
 * dsh — the murke shell command registry.
 * Every command receives (args, ctx). Print via ctx.print / ctx.printHTML.
 * No windows, no taskbar: apps launch as fullscreen takeovers and the
 * terminal is the machine.
 */

/** Boot reference for uptime; set by the shell on mount. */
export const bootRef: { at: number } = { at: Date.now() };

function fmtUptime(ms: number): string {
  const s = Math.max(1, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function kernelLabel(): string {
  try {
    const ua = navigator.userAgent;
    const webkit = /AppleWebKit\/([\d.]+)/.exec(ua);
    const gecko = /rv:([\d.]+)/.exec(ua);
    const gecko2 = /Gecko\/([\d.]+)/.exec(ua);
    if (webkit) return `WebKit ${webkit[1]}`;
    if (gecko) return `Gecko ${gecko[1]}`;
    if (gecko2) return `Gecko ${gecko2[1]}`;
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** The neofetch art = the demon sigil minus the DIE / HUMAN tags. The info
 *  column aligns against the same plain-text rows (widths unchanged).
 *  The sigil is recolored through themeArt so it matches the active theme. */
function neofetchHTMLClean(ctx: CommandContext, info: string[]): string {
  const rows = themeArt(MURKE_NEOFETCH_HTML, THEMES[ctx.theme].art).split("\n");
  const count = Math.max(rows.length, info.length);
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const art = rows[i] ?? "";
    const padLen = Math.max(3, MURKE_DEMON_WIDTH - (MURKE_DEMON_TEXT[i]?.length ?? 0) + 3);
    lines.push(art + " ".repeat(padLen) + (info[i] ?? ""));
  }
  return lines.join("\n");
}

/* ---------- man page (rendered inline — the terminal IS the pager) ---------- */

const CATEGORY_TITLES: Record<CommandDef["category"], string> = {
  fs: "FILE SYSTEM",
  apps: "APPLICATIONS",
  system: "SYSTEM",
  fun: "MISC",
};

function manPageLines(): string[] {
  const cmds = [...REGISTRY].sort((a, b) => a.name.localeCompare(b.name));
  const groups: CommandDef["category"][] = ["fs", "apps", "system", "fun"];
  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [];

  out.push("DSH(1)                        MURKE PROXY                        DSH(1)");
  out.push("");
  out.push("NAME");
  out.push("     dsh — the murke shell");
  out.push("");
  out.push("SYNOPSIS");
  out.push("     dsh command [arguments]");
  out.push("");
  out.push("DESCRIPTION");
  out.push("     dsh is a shell living in your browser. It drives a real");
  out.push("     IndexedDB-backed file system (the files app: drag files in,");
  out.push("     download off the web, take them back out), an mspaint-style");
  out.push("     editor and a full scramjet web proxy (streaming relay).");
  out.push("");
  out.push("     Apps take over the whole screen; alt+` (or the close");
  out.push("     button) hands control back to dsh.");
  out.push("");
  out.push("     Phosphor color is set with theme(1): hell (bsd red),");
  out.push("     amber, bone, minimal (amoled), void, toxic, blood, frost,");
  out.push("     static, classic (gunmetal purple) — each with its own");
  out.push("     living backdrop + sigil tint.");
  out.push("");
  out.push("COMMANDS");
  for (const g of groups) {
    out.push(`  ── ${CATEGORY_TITLES[g]} ${"─".repeat(Math.max(2, 38 - CATEGORY_TITLES[g].length))}`);
    for (const c of cmds.filter((x) => x.category === g)) {
      const left = `     ${c.name}${c.usage.slice(c.name.length)}`.padEnd(30);
      out.push(`${left}${c.desc}`);
    }
    out.push("");
  }
  out.push("KEYS");
  out.push("     Tab                  complete command / path (ghost shows the guess)");
  out.push("     ↑ / ↓                walk command history");
  out.push("     Ctrl+L               clear the screen");
  out.push("     Ctrl+C               abandon the current line");
  out.push("     Esc                  abandon input");
  out.push("     Alt+`                close the browser takeover");
  out.push("");
  out.push("MEDIA");
  out.push("     play <name>          chiptune synth from ~/Music");
  out.push("     fetch <url>          download any file into ~/Downloads");
  out.push("");
  out.push("CHAT");
  out.push("     chat opens the rooms: #global is everyone, click a name for a");
  out.push("     dm, +gc opens a public group. Logs are memory-only.");
  out.push("");
  out.push("FILES");
  out.push("     /etc/motd            message of the day");
  out.push("     ~/Documents/         readme, notes, credits");
  out.push("     ~/Music/*.mod        chiptune library (play)");
  out.push("     ~/Paintings/         output of paint (real pngs)");
  out.push("     ~/Downloads/         fetch(1) + browser download target");
  out.push("     ~/notes/             the notes app (notes, note)");
  out.push("     /var/log/daemon.log  boot log");
  out.push("");
  out.push("DIAGNOSTICS");
  out.push("     proxy status         probes the proxy transport and prints latency");
  out.push("     neofetch             system vitals");
  out.push("");
  out.push("BUGS");
  out.push("     The cursor blinks at exactly 1.06 seconds. This is not a bug.");
  out.push("");
  out.push(`MURKE 2.1                       ${today}                       DSH(1)`);
  return out;
}

const REGISTRY: CommandDef[] = [
  /* ---------------- file system ---------------- */
  {
    name: "ls",
    usage: "ls [path]",
    desc: "list directory contents",
    category: "fs",
    run(args, ctx) {
      const target = args.find((a) => !a.startsWith("-")) ?? ".";
      const node = ctx.vfs.getNode(target, ctx.getCwd());
      if (!node) {
        ctx.print(`ls: cannot access '${target}': No such file or directory`, "err");
        return;
      }
      if (node.type === "file") {
        ctx.print(node.name);
        return;
      }
      const items = ctx.vfs.list(target, ctx.getCwd());
      if (items.length === 0) {
        ctx.print("(empty)", "dim");
        return;
      }
      const rendered = items.map((n) => (n.type === "dir" ? n.name + "/" : n.name));
      const cols = 4;
      const width = Math.max(...rendered.map((r) => r.length)) + 3;
      for (let i = 0; i < rendered.length; i += cols) {
        const row = rendered
          .slice(i, i + cols)
          .map((r) => r.padEnd(width))
          .join("")
          .trimEnd();
        ctx.print(row, "out");
      }
    },
  },
  {
    name: "cd",
    usage: "cd <path>",
    desc: "change directory (cd .. goes up, cd ~ goes home)",
    category: "fs",
    run(args, ctx) {
      const target = args[0] ?? "~";
      const abs = ctx.vfs.resolve(target, ctx.getCwd());
      const node = ctx.vfs.getNode(abs);
      if (!node) {
        ctx.print(`cd: no such directory: ${target}`, "err");
        return;
      }
      if (node.type !== "dir") {
        ctx.print(`cd: not a directory: ${target}`, "err");
        return;
      }
      ctx.setCwd(abs);
    },
  },
  {
    name: "pwd",
    usage: "pwd",
    desc: "print working directory",
    category: "fs",
    run(_args, ctx) {
      ctx.print(ctx.getCwd());
    },
  },
  {
    name: "cat",
    usage: "cat <file> [file...]",
    desc: "print file contents",
    category: "fs",
    run(args, ctx) {
      if (args.length === 0) {
        ctx.print("cat: missing operand", "err");
        return;
      }
      for (const a of args) {
        const node = ctx.vfs.getNode(a, ctx.getCwd());
        if (!node) {
          ctx.print(`cat: ${a}: No such file or directory`, "err");
          continue;
        }
        if (node.type === "dir") {
          ctx.print(`cat: ${a}: Is a directory`, "err");
          continue;
        }
        for (const line of node.content.split("\n")) ctx.print(line);
      }
    },
  },
  {
    name: "mkdir",
    usage: "mkdir [-p] <dir>",
    desc: "create a directory (-p for parents)",
    category: "fs",
    run(args, ctx) {
      const recursive = args.includes("-p");
      const target = args.find((a) => !a.startsWith("-"));
      if (!target) {
        ctx.print("mkdir: missing operand", "err");
        return;
      }
      const err = ctx.vfs.mkdir(target, ctx.getCwd(), recursive);
      if (err) ctx.print(err, "err");
    },
  },
  {
    name: "rm",
    usage: "rm [-r] <path>",
    desc: "remove a file or directory (-r recursive)",
    category: "fs",
    run(args, ctx) {
      const recursive = args.includes("-r") || args.includes("-rf");
      const target = args.find((a) => !a.startsWith("-"));
      if (!target) {
        ctx.print("rm: missing operand", "err");
        return;
      }
      const err = ctx.vfs.remove(target, ctx.getCwd(), recursive);
      if (err) ctx.print(err, "err");
    },
  },
  {
    name: "touch",
    usage: "touch <file>",
    desc: "create an empty file",
    category: "fs",
    run(args, ctx) {
      if (!args[0]) {
        ctx.print("touch: missing file operand", "err");
        return;
      }
      const node = ctx.vfs.getNode(args[0], ctx.getCwd());
      if (node) return;
      const err = ctx.vfs.writeFile(args[0], "", ctx.getCwd());
      if (err) ctx.print(err, "err");
    },
  },
  {
    name: "echo",
    usage: "echo <text> [> file] [>> file]",
    desc: "print text, or write/append it to a file",
    category: "fs",
    run(args, ctx) {
      const gt = args.indexOf(">");
      const gtf = args.indexOf(">>");
      const idx = gt >= 0 && (gtf < 0 || gt < gtf) ? gt : gtf;
      if (idx === -1) {
        ctx.print(args.join(" "));
        return;
      }
      const text = args.slice(0, idx).join(" ");
      const target = args[idx + 1];
      if (!target) {
        ctx.print("dsh: syntax error near unexpected token 'newline'", "err");
        return;
      }
      const existing = idx === gtf ? (ctx.vfs.readFile(target, ctx.getCwd()) ?? "") : "";
      const err = ctx.vfs.writeFile(target, existing + text + "\n", ctx.getCwd());
      if (err) ctx.print(err, "err");
    },
  },
  {
    name: "tree",
    usage: "tree [path]",
    desc: "recursive directory listing",
    category: "fs",
    run(args, ctx) {
      const root = args[0] ?? ".";
      const abs = ctx.vfs.resolve(root, ctx.getCwd());
      const node = ctx.vfs.getNode(abs);
      if (!node || node.type !== "dir") {
        ctx.print(`tree: ${root}: Not a directory`, "err");
        return;
      }
      ctx.print(ctx.vfs.pretty(abs));
      let dirs = 0;
      let files = 0;
      const walk = (d: string, prefix: string) => {
        const items = ctx.vfs.list(d);
        items.forEach((n, i) => {
          const last = i === items.length - 1;
          const branch = last ? "└─ " : "├─ ";
          ctx.print(prefix + branch + n.name + (n.type === "dir" ? "/" : ""));
          if (n.type === "dir") {
            dirs++;
            walk(d === "/" ? "/" + n.name : d + "/" + n.name, prefix + (last ? "   " : "│  "));
          } else files++;
        });
      };
      walk(abs, "");
      ctx.print(``, "dim");
      ctx.print(`${dirs} directories, ${files} files`, "dim");
    },
  },

  /* ---------------- applications ---------------- */
  {
    name: "play",
    usage: "play [<song>]",
    desc: "play a chiptune from ~/music (no args = list)",
    category: "apps",
    run(args, ctx) {
      const tracks = ctx.synth.list();
      if (args.length === 0) {
        ctx.print("── daemon chiptune library ──", "dim");
        const playing = ctx.synth.nowPlaying();
        for (const t of tracks) {
          const mark = playing?.id === t.id ? "▶" : " ";
          ctx.print(`${mark} ${t.name.padEnd(24)} ${t.bpm}bpm  ${t.lengthSec}s`);
        }
        ctx.print(`play <name> — stop stops`, "dim");
        return;
      }
      const id = args.join(" ");
      if (!ctx.synth.play(id)) {
        ctx.print(`play: no such track: ${id}`, "err");
        return;
      }
      const now = ctx.synth.nowPlaying();
      ctx.print(`▶ ${now?.name ?? id} — ${now?.bpm}bpm · looping · 'stop' to halt`, "ok");
    },
  },
  {
    name: "stop",
    usage: "stop",
    desc: "stop the chiptune synth",
    category: "apps",
    run(_args, ctx) {
      ctx.synth.stop();
      ctx.print("■ stopped", "dim");
    },
  },
  {
    name: "paint",
    usage: "paint",
    desc: "fullscreen mspaint-style editor (saves pngs to ~/paintings)",
    category: "apps",
    run(_args, ctx) {
      ctx.openOverlay("paint");
    },
  },
  {
    name: "chat",
    usage: "chat",
    desc: "live rooms — #global, dms (click a name), +gc groups",
    category: "apps",
    run(_args, ctx) {
      ctx.openOverlay("chat");
    },
  },
  {
    name: "notes",
    usage: "notes",
    desc: "fullscreen notes app (saves to ~/notes)",
    category: "apps",
    run(_args, ctx) {
      ctx.openOverlay("notes");
    },
  },
  {
    name: "note",
    usage: "note <text>",
    desc: "quick-append a line to ~/notes/inbox.txt",
    category: "apps",
    run(args, ctx) {
      const text = args.join(" ").trim();
      if (!text) {
        ctx.print("usage: note <text>", "err");
        return;
      }
      ctx.vfs.mkdir("~/notes", undefined, true);
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      const prev = ctx.vfs.readFile("~/notes/inbox.txt") ?? "";
      const err = ctx.vfs.writeFile("~/notes/inbox.txt", `${prev}- [${stamp}] ${text}\n`);
      if (err) {
        ctx.print(err, "err");
        return;
      }
      ctx.print("noted. — 'notes' opens the editor, 'cat ~/notes/inbox.txt' reads it", "ok");
    },
  },
  {
    name: "files",
    usage: "files [path]",
    desc: "the file manager — sidebar, grid/list, drag-drop upload, properties",
    category: "apps",
    run(args, ctx) {
      const target = args.length > 0 ? ctx.vfs.resolve(args.join(" "), ctx.getCwd()) : undefined;
      ctx.openOverlay("files", target);
    },
  },
  {
    name: "fetch",
    usage: "fetch <url>",
    desc: "download a file off the web into ~/Downloads (through the proxy)",
    category: "apps",
    run(args, ctx) {
      void (async () => {
        const url = args[0];
        if (!url || !/^https?:\/\//i.test(url)) {
          ctx.print("usage: fetch <https url>", "err");
          return;
        }
        ctx.print(`fetching ${url.slice(0, 72)}…`, "dim");
        try {
          const meta = await fetchIntoVfs(url, ctx.vfs);
          ctx.print(`↓ ${meta.name} — ${formatBytes(meta.size)} → ${meta.path}`, "ok");
          ctx.print("  'files' opens the file manager", "dim");
        } catch (e) {
          ctx.print(`fetch: ${e instanceof Error ? e.message : String(e)}`, "err");
        }
      })();
    },
  },
  {
    name: "mv",
    usage: "mv <from> <to>",
    desc: "move or rename a file/folder",
    category: "fs",
    run(args, ctx) {
      if (args.length < 2) {
        ctx.print("usage: mv <from> <to>", "err");
        return;
      }
      const err = ctx.vfs.move(args[0], args[1], ctx.getCwd());
      if (err) ctx.print(err, "err");
    },
  },
  {
    name: "weather",
    usage: "weather [<city>]",
    desc: "real forecast — auto-locates you, or name a city",
    category: "apps",
    run(args, ctx) {
      void (async () => {
        const city = args.length > 0 ? args.join(" ") : undefined;
        ctx.print(city ? `scrying ${city}…` : "scrying the sky above you…", "dim");
        const w = await fetchWeather(city);
        if (!w) {
          ctx.print("weather: the sky is unreachable — check the city name or your link", "err");
          return;
        }
        /* your own coordinates — the globe spins horizontally to face them
           (cached, so bare `weather` doesn't refetch what fetchWeather just
           used) */
        const userGeo = await fetchUserGeo();
        const uLat = userGeo?.lat ?? w.lat;
        const uLon = userGeo?.lon ?? w.lon;
        /* the api echo of lat/lon can be missing (wttr path) — when the
           browser-side geo fix exists, the POSITION legend uses it too.
           geoSrc labels the fix (gps fix / ip fix) in the legend. */
        if (typeof uLat === "number" && typeof uLon === "number") {
          w.lat = uLat;
          w.lon = uLon;
          w.geoSrc = userGeo?.src ?? "ip";
        }
        /* weather readout left, black grey-earth right — the globe stretches
           to EXACTLY the height of the text block (flex stretch +
           aspect-ratio), and the shell's render pass owns mounting
           (mountAllGlobes). data-lat/lon = forecast marker, data-ulat/ulon =
           your spot, data-place = the bubble that rides next to the pin. */
        const geo =
          typeof w.lat === "number" && typeof w.lon === "number"
            ? ` data-lat="${w.lat}" data-lon="${w.lon}"`
            : "";
        const ugeo =
          typeof uLat === "number" && typeof uLon === "number"
            ? ` data-ulat="${uLat}" data-ulon="${uLon}"`
            : "";
        const pgeo = ` data-place="${w.place.replace(/&/g, "&amp;").replace(/"/g, "&quot;").slice(0, 64)}"`;
        /* info-card fields (temp / condition / wind / rain / hum) — the
           globe's dive shows them next to the cloud graph */
        const ig = weatherCardAttrs(w);
        /* 12h cloud cover + their hour numbers — the globe's hover zoom
           reads these and draws the cloud graph card */
        const withClouds = (w.hourly ?? []).slice(0, 12).filter((h) => typeof h.cloudPct === "number");
        const cgeo =
          withClouds.length >= 4
            ? ` data-clouds="${withClouds.map((h) => h.cloudPct).join(",")}" data-hours="${withClouds
                .map((h) => h.hour)
                .join(",")}"`
            : "";
        const globeCanvas =
          `<canvas class="daemon-globe" aria-hidden="true"${geo}${ugeo}${pgeo}${ig}${cgeo} ` +
          `style="height:100%;width:auto;aspect-ratio:1/1;max-height:380px;min-height:150px;display:block"></canvas>`;
        const html =
          '<div style="display:flex;align-items:stretch;gap:26px;flex-wrap:wrap">' +
          '<pre style="margin:0;font-family:inherit;font-size:inherit;white-space:pre">' +
          renderWeatherHTML(w) +
          "</pre>" +
          '<div style="flex:1 1 auto;min-width:190px;display:flex;align-items:center;justify-content:flex-end">' +
          globeCanvas +
          "</div></div>";
        ctx.printHTML(html, false, true);
      })();
    },
  },
  {
    name: "proxy",
    usage: "proxy [<url>|status|wisp <url>|newtab]",
    desc: "browse the real web — bare `proxy` lands on the new tab page",
    category: "apps",
    run(args, ctx) {
      void (async () => {
        const sub = args[0];
        if (!sub) {
          // the new tab page — search box, quick links, the clock
          ctx.openOverlay("browser", NEWTAB_URL);
          return;
        }
        if (sub === "newtab") {
          ctx.openOverlay("browser", NEWTAB_URL);
          return;
        }
        if (sub === "status") {
          ctx.print("probing transports…", "dim");
          const s = await ctx.proxy.status();
          if (s.ok && s.wispUrl) {
            ctx.print(`  transport ${s.transport ?? "relay"}`, "ok");
            ctx.print(`  endpoint  ${s.wispUrl}`);
            if (typeof s.latencyMs === "number") ctx.print(`  latency   ${s.latencyMs}ms`);
          } else {
            ctx.print(`  transport offline`, "err");
            ctx.print(`  ${s.error ?? "unknown error"}`, "err");
          }
          return;
        }
        if (sub === "wisp") {
          const u = args[1];
          if (!u || u === "clear") {
            ctx.proxy.setWispOverride(null);
            ctx.print("override cleared — back to the auto-probe (relay, then wisp)", "dim");
            return;
          }
          ctx.proxy.setWispOverride(u);
          ctx.print("probing…", "dim");
          const s = await ctx.proxy.status();
          if (s.ok) ctx.print(`transport set: ${s.transport ?? "relay"} @ ${s.wispUrl} (${s.latencyMs ?? "?"}ms)`, "ok");
          else ctx.print(`saved, but unreachable: ${s.error}`, "err");
          return;
        }
        // proxy <url or search> — fullscreen browser takeover
        const query = args.join(" ");
        const target = normalizeTarget(query);
        ctx.openOverlay("browser", target);
      })();
    },
  },
  {
    name: "newtab",
    usage: "newtab",
    desc: "open the proxy's new tab page",
    category: "apps",
    run(_args, ctx) {
      ctx.openOverlay("browser", NEWTAB_URL);
    },
  },

  /* ---------------- system ---------------- */
  {
    name: "help",
    usage: "help [<command>]",
    desc: "the dsh manual, man(1)-style — or detail one command",
    category: "system",
    run(args, ctx) {
      if (args[0]) {
        const c = findCommand(args[0]);
        if (!c) {
          ctx.print(`help: no entry for '${args[0]}' — try 'help' for the manual`, "err");
          return;
        }
        ctx.print(c.name.toUpperCase() + c.usage.slice(c.name.length), "ok");
        ctx.print(`  ${c.desc}`, "dim");
        ctx.print(`  category: ${CATEGORY_TITLES[c.category].toLowerCase()}`, "dim");
        return;
      }
      for (const line of manPageLines()) ctx.print(line);
    },
  },
  {
    name: "credits",
    usage: "credits",
    desc: "who built this place (<3)",
    category: "system",
    run(_args, ctx) {
      ctx.print("", "dim");
      ctx.print("  murke", "ok");
      ctx.print("", "dim");
      ctx.print("  developed by", "dim");
      ctx.print("    b29s (dan)   <3", "ok");
      ctx.print("    GLM    <3", "ok");
      ctx.print("", "dim");
      ctx.print("  proxy core");
      ctx.print("    scramjet · wisp transport (mercury workshop)");
      ctx.print("", "dim");
    },
  },
  {
    name: "theme",
    usage: `theme <${THEME_ORDER.join("|")}>`,
    desc: "switch phosphor color — each theme recolors the sigil + backdrop",
    category: "system",
    run(args, ctx) {
      const t = args[0];
      if (!t || !isThemeName(t)) {
        ctx.print("themes:", "dim");
        for (const name of THEME_ORDER) ctx.print(`  ${name.padEnd(9)} ${THEMES[name].label}`);
        ctx.print(`usage: theme <${THEME_ORDER.join("|")}>`, "dim");
        return;
      }
      ctx.setTheme(t);
      ctx.print(`phosphor → ${THEMES[t].label}`, "dim");
    },
  },
  {
    name: "crt",
    usage: "crt [on|off]",
    desc: "toggle the CRT scanline overlay (subtle)",
    category: "system",
    run(args, ctx) {
      const arg = args[0];
      const next = arg === "on" ? true : arg === "off" ? false : !ctx.crt;
      ctx.setCrt(next);
      ctx.print(`crt overlay ${next ? "on" : "off"}`, "dim");
    },
  },
  {
    name: "sound",
    usage: "sound [on|off]",
    desc: "toggle mechanical keyboard audio (off by default)",
    category: "system",
    run(args, ctx) {
      const arg = args[0];
      const next = arg === "on" ? true : arg === "off" ? false : !ctx.sound.enabled;
      ctx.sound.setEnabled(next);
      ctx.print(`keyboard sfx ${ctx.sound.enabled ? "on — thock thock" : "off"}`, "dim");
    },
  },
  {
    name: "clear",
    usage: "clear",
    desc: "wipe the screen (also Ctrl+L)",
    category: "system",
    run(_args, ctx) {
      ctx.clear();
    },
  },
  {
    name: "history",
    usage: "history",
    desc: "show command history",
    category: "system",
    run(_args, ctx) {
      const h = historyRef.current;
      if (h.length === 0) {
        ctx.print("(no history yet)", "dim");
        return;
      }
      h.forEach((c, i) => ctx.print(`${String(i + 1).padStart(4)}  ${c}`));
    },
  },
  {
    name: "whoami",
    usage: "whoami",
    desc: "who are you, really",
    category: "fun",
    run(_args, ctx) {
      ctx.print("guest (uid=1000)");
    },
  },
  {
    name: "date",
    usage: "date",
    desc: "current date and time",
    category: "system",
    run(_args, ctx) {
      ctx.print(new Date().toString());
    },
  },
  {
    name: "motd",
    usage: "motd",
    desc: "reprint the message of the day",
    category: "system",
    run(_args, ctx) {
      const motd = ctx.vfs.readFile("/etc/motd") ?? "";
      for (const line of motd.split("\n")) ctx.print(line);
    },
  },
  {
    name: "banner",
    usage: "banner",
    desc: "print the murke wordmark",
    category: "fun",
    run(_args, ctx) {
      ctx.print(MURKE_BANNER, "ok");
    },
  },
  {
    name: "murke",
    usage: "murke",
    desc: "print the full sigil",
    category: "fun",
    run(_args, ctx) {
      ctx.printHTML(themeArt(MURKE_ART_HTML, THEMES[ctx.theme].art));
    },
  },
  {
    name: "neofetch",
    usage: "neofetch",
    desc: "system info, neofetch-style — sigil left, vitals right",
    category: "fun",
    run(_args, ctx) {
      void (async () => {
        const uptime = fmtUptime(Date.now() - bootRef.at);
        const res = `${window.screen?.width ?? "?"}x${window.screen?.height ?? "?"}@${window.devicePixelRatio || 1}x`;
        const nav = navigator as Navigator & { deviceMemory?: number };
        const info: string[] = [];
        const label = (k: string, v: string): string =>
          `  <b>${escMaybe(k)}</b><span style="color:${THEMES[ctx.theme].dim}">: </span>${escMaybe(v)}`;
        function escMaybe(s: string): string {
          return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }

        const proxyStat = await ctx.proxy.status();

        info.push(`  <span style="color:${THEMES[ctx.theme].hi}"><b>guest@murke</b></span>`);
        info.push(`  <span style="color:${THEMES[ctx.theme].dim}">───────────────</span>`);
        info.push(label("OS", "Murke Proxy 2.1"));
        info.push(label("Host", location.host || "localhost"));
        info.push(label("Kernel", kernelLabel()));
        info.push(label("Uptime", uptime));
        info.push(label("Shell", "dsh 2.1"));
        info.push(label("Resolution", res));
        info.push(label("Theme", `${THEMES[ctx.theme].label}`));
        info.push(label("Display", ctx.crt ? "crt scanlines" : "raw phosphor"));
        info.push(label("CPU", navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : "unknown"));
        if (nav.deviceMemory) info.push(label("Memory", `${nav.deviceMemory} GB`));
        info.push(
          label(
            "Proxy",
            proxyStat.ok ? `proxy ok${proxyStat.latencyMs != null ? ` (${proxyStat.latencyMs}ms)` : ""}` : "offline"
          )
        );
        info.push("");
        info.push(
          `  ` +
            ["--term-brand", "--term-fg", "--term-hi", "--term-dim", "--term-err"]
              .map(
                (v) =>
                  `<span style="background:${cssVar(v)};color:${cssVar(v)}">███</span>`
              )
              .join("")
        );
        // plain command-response size: left aligned, no frame, no auto-fit
        ctx.printHTML(neofetchHTMLClean(ctx, info), false);
      })();
    },
  },
  {
    name: "sudo",
    usage: "sudo <anything>",
    desc: "nice try",
    category: "fun",
    run(args, ctx) {
      if (args.length === 0) {
        ctx.print("usage: sudo <make me a sandwich>", "dim");
        return;
      }
      ctx.print("sudo: permission granted.", "dim");
    },
  },
  {
    name: "exit",
    usage: "exit",
    desc: "log out — the gate returns, blank as ever",
    category: "system",
    run(_args, ctx) {
      ctx.logout();
    },
  },
];

function cssVar(name: string): string {
  try {
    const host = document.querySelector<HTMLElement>(".murke-root") ?? document.documentElement;
    return getComputedStyle(host).getPropertyValue(name).trim() || "#888";
  } catch {
    return "#888";
  }
}

/** `history` needs the session history; the shell injects it here. */
export const historyRef: { current: string[] } = { current: [] };

export function normalizeTarget(q: string): string {
  const s = q.trim();
  if (!s) return "https://lite.duckduckgo.com/lite/";
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s);
  if (looksLikeUrl) {
    return /^https?:\/\//i.test(s) ? s : "https://" + s;
  }
  // the static lite endpoint: zero JS-wall, plain GET results — it renders
  // and searches through every transport (the JS-heavy duckduckgo homepage
  // regularly dies behind proxies, and html.duckduckgo.com challenge-loops)
  return "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(s);
}

export function findCommand(name: string): CommandDef | undefined {
  return REGISTRY.find((c) => c.name === name);
}

export function listCommands(): CommandDef[] {
  return REGISTRY;
}

export function commandNames(): string[] {
  return REGISTRY.map((c) => c.name);
}

export type { CommandContext };
