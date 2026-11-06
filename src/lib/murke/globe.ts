/**
 * daemon-globe v7 — the world for the weather command.
 *
 * THE LOOK: a BLACK planet with grey continents. The NASA Blue Marble map
 * (inlined as a data URI, see earth-texture.ts) is desaturated and crushed
 * to luminance at load: oceans fall to near-black, land reads as mid-grey.
 * No atmosphere shell, no fresnel rim, NO GLOW — flat black space.
 *
 * SIZING: the canvas stretches to exactly the height of the weather text
 * block beside it (flex align-items:stretch + aspect-ratio). The renderer
 * matches the canvas box every frame, square or not.
 *
 * CHOREOGRAPHY:
 *   intro — the planet settles the SHORT way (either direction, whichever
 *   is closer) to bring YOUR location face-on, then the camera DIVES IN —
 *   and the dive AIMS AT YOUR PIN (the camera flies out along the pin's
 *   own direction and looks straight at it), so your spot is CENTERED in
 *   frame at every latitude, not just near the equator. The info card
 *   (place · temp · condition · wind · rain · 12h clouds) fades up.
 *
 *   drag — grab it anywhere and throw it: horizontal drag spins the planet
 *   both ways (with a little fling inertia), vertical drag tilts your
 *   viewing height. The moment a drag starts the globe returns to NORMAL
 *   SIZE (zoom reset + card hides). pointerdown is canceled-default and
 *   the canvas is user-select:none — the browser may NOT steal the gesture
 *   for text selection (that pointercancel used to kill drags after ~10px).
 *   Five seconds after you let go it glides back to hover over your spot.
 *
 *   hover — hovering re-dives to your spot + card; the spin glides home
 *   with the dive, so the pin is always framed when the camera arrives.
 *
 * TRANSFORM MODEL (v7): no Euler-order archaeology. rig.rotation.y = spin
 * (outer group) and an inner tiltGroup.rotation.z = TILT (earth + pins).
 * Child world = Ry(spin) · Rz(TILT) · v — the exact order the facing-angle
 * math assumes, by construction. The pin's world position is computed with
 * the same closed form every frame to aim the dive.
 *
 * FLASH-FREE by design: colors only move on a real theme switch.
 *
 * Imperative on purpose: the weather output is printed HTML, so the shell
 * drops a <canvas class="daemon-globe"> into the stream and calls
 * mountAllGlobes() on every render pass. Globes whose canvas leaves the
 * DOM dispose themselves — and forceContextLoss() releases the WebGL slot
 * immediately, so remounts never exhaust the browser's context budget.
 */
"use client";

import { EARTH_TEXTURE_URL } from "./earth-texture";

interface GlobeLoc {
  lat: number;
  lon: number;
}

interface GlobeRig {
  canvas: HTMLCanvasElement;
  dispose(): void;
}

const rigs: GlobeRig[] = [];

/** Canvases with a mount currently in flight (mountGlobe is async) — WeakSet
 *  on purpose: no attribute writes, so the host tree stays byte-identical
 *  to what React rendered (React 19 re-writes innerHTML otherwise). */
const pending = new WeakSet<HTMLCanvasElement>();

/** Dispose rigs whose canvas left the DOM; keeps the array tidy. */
function sweep(): void {
  for (let i = rigs.length - 1; i >= 0; i--) {
    if (!rigs[i].canvas.isConnected) {
      rigs[i].dispose();
      rigs.splice(i, 1);
    }
  }
}

function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Self-healing mount: fresh .daemon-globe canvases (carrying data-lat /
 * data-lon, data-ulat / data-ulon, data-place and the data-temp/-cond/
 * -wind/-rain/-hum info card fields) get a globe; disconnected rigs
 * dispose themselves.
 *
 * Idempotent by RIG MEMBERSHIP: a canvas counts as live only when a rig
 * actually holds it (or its mount is still in flight), never via a marker
 * attribute — the canvas must not be touched outside three's own setup.
 */
export function mountAllGlobes(): void {
  sweep();
  const canvases = document.querySelectorAll<HTMLCanvasElement>("canvas.daemon-globe");
  for (const c of canvases) {
    if (rigs.some((r) => r.canvas === c)) continue; // already live
    if (pending.has(c)) continue; // mount in flight
    const num = (k: string): number | null => {
      const raw = c.dataset[k];
      if (raw === undefined) return null;
      const v = Number(raw);
      return Number.isFinite(v) ? v : null;
    };
    const lat = num("lat");
    const lon = num("lon");
    const ulat = num("ulat");
    const ulon = num("ulon");
    const loc = lat !== null && lon !== null ? { lat, lon } : undefined;
    const userLoc = ulat !== null && ulon !== null ? { lat: ulat, lon: ulon } : loc;
    const place = c.dataset.place ?? "";
    const clouds = (c.dataset.clouds ?? "")
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
    const hours = (c.dataset.hours ?? "")
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    pending.add(c);
    mountGlobe(c, {
      loc,
      userLoc,
      place,
      clouds,
      hours,
      temp: c.dataset.temp ?? "",
      cond: c.dataset.cond ?? "",
      wind: c.dataset.wind ?? "",
      rain: c.dataset.rain ?? "",
      hum: c.dataset.hum ?? "",
    });
  }
}

/** lat/lon (degrees) -> position on the unit sphere, y up, Greenwich at +x. */
function latLonToVec3(lat: number, lon: number, r: number): [number, number, number] {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return [-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)];
}

/** Wrap an angle difference into [-π, π). */
function wrapPi(a: number): number {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Crisp round dot for the location pin — solid core + thin ring, no glow. */
function pinTexture(THREE: typeof import("three")): import("three").Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 64, 64);
  // thin outer ring
  ctx.beginPath();
  ctx.arc(32, 32, 22, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();
  // solid core
  ctx.beginPath();
  ctx.arc(32, 32, 12, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Desaturate the blue-marble into the BLACK + GREY earth: luminance only,
 * level-crushed so oceans go near-black and land reads as grey.
 */
function greyEarthTexture(THREE: typeof import("three"), img: HTMLImageElement): import("three").Texture {
  const w = 2048;
  const h = 1024;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  try {
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      // crush: dark oceans sink to black, land/clouds stay readable grey
      const v = Math.min(255, Math.pow(lum / 255, 1.35) * 235);
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
  } catch {
    /* canvas tainted (shouldn't happen — data uri) — fall through */
  }
  const tex = new THREE.CanvasTexture(c);
  const srgb = (THREE as unknown as { SRGBColorSpace?: unknown }).SRGBColorSpace;
  if (srgb) tex.colorSpace = srgb as import("three").ColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Load the texture image (HTMLImageElement, so it can be re-drawn grey). */
function loadEarthImage(src: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const t = window.setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      window.clearTimeout(t);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(t);
      resolve(null);
    };
    img.src = src;
  });
}

/** html-escape for the info-card text fields (they come from weather data). */
function cardEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Mount the black grey-earth onto a canvas already in the DOM.
 * `loc` pins the forecast marker; `userLoc` is YOUR coordinates — the spin
 * target (defaults to loc). `place` names the bubble that rides next to it.
 * `clouds`/`hours` feed the 12h cloud graph. `temp`/`cond`/`wind`/`rain`/
 * `hum` are preformatted strings for the info card.
 */
export function mountGlobe(
  canvas: HTMLCanvasElement,
  opts: {
    loc?: GlobeLoc;
    userLoc?: GlobeLoc;
    place?: string;
    clouds?: number[];
    hours?: number[];
    temp?: string;
    cond?: string;
    wind?: string;
    rain?: string;
    hum?: string;
  } = {},
): void {
  sweep();
  if (rigs.some((r) => r.canvas === canvas)) return;
  const { loc, userLoc = loc, place, clouds, hours, temp, cond, wind, rain, hum } = opts;

  void (async () => {
    const THREE = await import("three");
    if (!canvas.isConnected) {
      pending.delete(canvas);
      return;
    }

    let renderer: import("three").WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      pending.delete(canvas);
      return; // no webgl — the text weather still stands alone
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0); // fully transparent — no glow box

    const box = () => ({
      w: Math.max(2, Math.floor(canvas.clientWidth) || 210),
      h: Math.max(2, Math.floor(canvas.clientHeight) || 210),
    });

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 12);
    camera.position.set(0, 0.32, 3.6);
    camera.lookAt(0, 0, 0);

    /* lighting: flat and shadowless — the blackness comes from the texture */
    scene.add(new THREE.AmbientLight(0xffffff, 1.5));

    /* TRANSFORM MODEL: outer `rig` spins (rotation.y), inner `tilt` carries
       the axial tilt (rotation.z). Child world = Ry(spin)·Rz(TILT)·v — the
       exact composition the facing math below uses. No Euler order needed. */
    const rig = new THREE.Group();
    const tilt = new THREE.Group();
    const TILT = (23.4 * Math.PI) / 180; // axial tilt
    tilt.rotation.z = TILT;
    rig.add(tilt);
    scene.add(rig);

    /* the planet — real texture crushed to black + grey */
    const texLoader = new THREE.TextureLoader();
    let earthMat: import("three").MeshPhongMaterial;
    const img = await loadEarthImage(EARTH_TEXTURE_URL);
    if (img) {
      const grey = greyEarthTexture(THREE, img);
      // tiny specular so the terminator still has shape — near-black shine
      earthMat = new THREE.MeshPhongMaterial({ map: grey, specular: new THREE.Color(0x0a0a0a), shininess: 8 });
    } else {
      // texture hiccup — plain black sphere, the text weather still stands
      earthMat = new THREE.MeshPhongMaterial({ color: 0x050505, specular: new THREE.Color(0x0a0a0a), shininess: 8 });
    }
    void texLoader;
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), earthMat);
    tilt.add(earth);

    const pal = {
      brand: cssVar(canvas, "--term-brand", "#e03131"),
      hi: cssVar(canvas, "--term-hi", "#ffd8a8"),
    };

    /* location pins — YOUR spot (the spin target); forecast spot when elsewhere */
    const mkMarker = (at: GlobeLoc, color: string, size0: number): import("three").Points => {
      const [x, y, z] = latLonToVec3(at.lat, at.lon, 1.012);
      const mg = new THREE.BufferGeometry();
      mg.setAttribute("position", new THREE.BufferAttribute(new Float32Array([x, y, z]), 3));
      const mm = new THREE.PointsMaterial({
        size: size0,
        map: pinTexture(THREE),
        color: new THREE.Color(color),
        transparent: true,
        depthWrite: false,
      });
      const p = new THREE.Points(mg, mm);
      tilt.add(p);
      return p;
    };
    const sameSpot =
      loc && userLoc && Math.abs(loc.lat - userLoc.lat) < 0.01 && Math.abs(loc.lon - userLoc.lon) < 0.01;
    const userMark = userLoc ? mkMarker(userLoc, pal.brand, 0.085) : null;
    const forecastMark = loc && !sameSpot ? mkMarker(loc, pal.hi, 0.07) : null;

    /* YOUR pin in TILT-GROUP space — Rz(TILT) applied to its local position.
       World position is recovered from the spin with the closed form below.
       Null when there is no fix at all (no dive target, camera dives straight-on). */
    const tiltC = Math.cos(TILT);
    const tiltS = Math.sin(TILT);
    const faceLoc = userLoc ?? loc ?? null;
    const uw = faceLoc
      ? (() => {
          const [x, y, z] = latLonToVec3(faceLoc.lat, faceLoc.lon, 1.012);
          return { x: x * tiltC - y * tiltS, y: x * tiltS + y * tiltC, z };
        })()
      : null;
    const markerWorld = (s: number): [number, number, number] | null => {
      if (!uw) return null;
      const cs = Math.cos(s);
      const sn = Math.sin(s);
      return [uw.x * cs + uw.z * sn, uw.y, -uw.x * sn + uw.z * cs];
    };

    /* the spin angle that brings YOUR pin face-on: Ry(s)·uw must land on
       the camera axis (x = 0 with z > 0) — solved in closed form. */
    const target = uw ? Math.atan2(-uw.x, uw.z) : 0;

    /* the place-name bubble — created here, positioned every frame */
    let bubble: HTMLDivElement | null = null;
    let bubbleHost: HTMLElement | null = null;
    const placeName = (place || "").trim();
    if (placeName && canvas.parentElement) {
      bubbleHost = canvas.parentElement;
      if (getComputedStyle(bubbleHost).position === "static") {
        bubbleHost.style.position = "relative";
      }
      bubble = document.createElement("div");
      bubble.className = "daemon-globe-bubble";
      bubble.textContent = placeName;
      bubble.setAttribute("aria-hidden", "true");
      bubble.style.cssText =
        "position:absolute;left:0;top:0;pointer-events:none;white-space:nowrap;" +
        "font:600 10px/1.5 ui-monospace,Menlo,Consolas,monospace;letter-spacing:0.08em;" +
        "padding:2px 7px;border:1px solid var(--term-brand);color:var(--term-fg);" +
        "background:color-mix(in srgb,var(--term-bg) 88%,black);" +
        "box-shadow:0 2px 8px rgba(0,0,0,.55);opacity:0;transition:opacity .5s ease;" +
        "text-transform:uppercase;z-index:3";
      bubbleHost.appendChild(bubble);
    }

    /* theme switch → recolor pins + bubble + card border only */
    const onTheme = () => {
      const p = { brand: cssVar(canvas, "--term-brand", "#e03131"), hi: cssVar(canvas, "--term-hi", "#ffd8a8") };
      if (userMark) (userMark.material as import("three").PointsMaterial).color.set(p.brand);
      if (forecastMark) (forecastMark.material as import("three").PointsMaterial).color.set(p.hi);
      if (bubble) bubble.style.borderColor = p.brand;
      if (card) {
        card.style.borderColor = p.brand;
        for (const b of Array.from(card.querySelectorAll("[data-bar]")) as HTMLElement[]) {
          b.style.background = b.dataset.bar === "now" ? p.brand : "color-mix(in srgb, currentColor 55%, transparent)";
        }
      }
    };
    window.addEventListener("murke-theme", onTheme);

    /* ---------- the info card ----------
       Shows what the dive is FOR: place · temp · condition · wind · rain
       · humidity, plus the 12h cloud-cover graph when hourly data exists.
       Appears with the zoom-in (hover or the automatic intro dive), hides
       on drag / leave. Pure DOM — no flicker, no rAF, one transition. */
    const hs = hours ?? [];
    const hasClouds = Array.isArray(clouds) && clouds.length >= 4;
    const hasInfo = Boolean((temp || cond) && canvas.parentElement) || (hasClouds && Boolean(canvas.parentElement));
    let card: HTMLDivElement | null = null;
    if (hasInfo && canvas.parentElement) {
      const host = canvas.parentElement;
      const nowPct = (clouds ?? [])[0] ?? 0;
      const head =
        (temp || cond
          ? `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">` +
            `<span style="font:600 9px/1.3 ui-monospace,Menlo,monospace;letter-spacing:0.14em;color:var(--term-dim);text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cardEsc(placeName || "your sky")}</span>` +
            (temp ? `<span style="font:700 15px/1 ui-monospace,Menlo,monospace;color:var(--term-brand)">${cardEsc(temp)}</span>` : "") +
            `</div>` +
            (cond ? `<div style="font:500 10px/1.5 ui-monospace,Menlo,monospace;color:var(--term-fg);text-transform:capitalize">${cardEsc(cond)}</div>` : "") +
            (wind || rain || hum
              ? `<div style="font:500 9px/1.6 ui-monospace,Menlo,monospace;color:var(--term-dim)">${[
                  wind ? `wind ${cardEsc(wind)}` : "",
                  rain ? `rain ${cardEsc(rain)}` : "",
                  hum ? `hum ${cardEsc(hum)}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}</div>`
              : "")
          : "");
      const bars = hasClouds
        ? (clouds ?? [])
            .slice(0, 12)
            .map((pct, i) => {
              const h = hs[i] ?? i;
              const hp = Math.max(6, Math.round((pct / 100) * 44));
              const label = i === 0 ? "now" : String(h).padStart(2, "0");
              return (
                `<span style="flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0">` +
                `<span style="font:500 8px/1 ui-monospace,Menlo,monospace;color:var(--term-dim)">${pct}</span>` +
                `<span data-bar="${i === 0 ? "now" : "rest"}" style="display:block;width:7px;height:${hp}px;` +
                (i === 0 ? `background:var(--term-brand);` : `background:color-mix(in srgb,currentColor 55%,transparent);`) +
                `border-radius:1px"></span>` +
                `<span style="font:500 8px/1 ui-monospace,Menlo,monospace;color:${i === 0 ? "var(--term-hi)" : "var(--term-dim)"}">${label}</span>` +
                `</span>`
              );
            })
            .join("")
        : "";
      const cloudBlock = hasClouds
        ? `<div style="margin-top:7px;padding-top:6px;border-top:1px solid color-mix(in srgb,currentColor 25%,transparent)">` +
          `<div style="font:600 9px/1 ui-monospace,Menlo,monospace;letter-spacing:0.14em;color:var(--term-fg);` +
          `display:flex;justify-content:space-between;gap:8px;margin-bottom:6px">` +
          `<span>CLOUDS · NEXT 12H</span><span style="color:var(--term-dim)">${nowPct}% now</span></div>` +
          `<div style="display:flex;align-items:flex-end;gap:3px;height:58px">${bars}</div></div>`
        : "";
      card = document.createElement("div");
      card.className = "daemon-globe-card";
      card.setAttribute("aria-hidden", "true");
      card.innerHTML = head + cloudBlock;
      card.style.cssText =
        "position:absolute;left:6px;right:6px;bottom:6px;z-index:4;pointer-events:none;" +
        "padding:8px 10px;border:1px solid var(--term-brand);" +
        "background:color-mix(in srgb,var(--term-bg) 90%,black);" +
        "box-shadow:0 2px 10px rgba(0,0,0,.6);opacity:0;transform:translateY(6px);" +
        "transition:opacity .35s ease,transform .35s ease";
      host.appendChild(card);
    }

    /* ---------- interaction state machine ----------
       intro : settle the short way to YOUR spot, then auto-dive + card.
       idle  : hover dives again; inertia spins; a past drag schedules a
               glide-back. Diving/zoomed also glides the spin home so the
               pin is framed when the camera gets there.
       drag  : pointer held — spin both ways, tilt the view, normal size. */
    const HOLD_EPS = 0.0035;
    let mode: "intro" | "idle" | "drag" = "intro";
    let spin = target + Math.PI * 1.5; // start a turn and a half away
    let returnAt = 0; // performance.now() when the glide-back should start
    let returning = false;
    let camYOff = 0; // vertical drag offset (viewing height)
    let angVel = 0; // fling inertia (rad/s) after release

    const CAM_OUT = { x: 0, y: 0.32, z: 3.6 };
    const CAM_IN_Z = 2.1; // dive distance along the pin's own direction
    const LOOK_IN = 0.85; // dive look-at: 85% out toward the pin — pin centered
    let zoom = 0; // 0 = out (normal size), 1 = in (dived onto your spot)
    let zoomTarget = 0;

    const applyCamera = () => {
      /* dive pose: out along the pin's CURRENT world direction, looking at
         a point just inside it — the pin lands dead-center at any latitude */
      let inX = 0;
      let inY = 0.12;
      let inZ = CAM_IN_Z;
      let lx = 0;
      let ly = 0;
      let lz = 0;
      const mw = markerWorld(spin);
      if (mw) {
        const len = Math.hypot(mw[0], mw[1], mw[2]) || 1;
        inX = (mw[0] / len) * CAM_IN_Z;
        inY = (mw[1] / len) * CAM_IN_Z;
        inZ = (mw[2] / len) * CAM_IN_Z;
        lx = mw[0] * LOOK_IN;
        ly = mw[1] * LOOK_IN;
        lz = mw[2] * LOOK_IN;
      }
      const outY = CAM_OUT.y + camYOff * (1 - zoom); // vertical-drag height fades as you dive
      camera.position.set(
        CAM_OUT.x + (inX - CAM_OUT.x) * zoom,
        outY + (inY - outY) * zoom,
        CAM_OUT.z + (inZ - CAM_OUT.z) * zoom,
      );
      camera.lookAt(lx * zoom, ly * zoom, lz * zoom);
    };

    const setCard = (on: boolean) => {
      if (!card) return;
      card.style.opacity = on ? "1" : "0";
      card.style.transform = on ? "translateY(0)" : "translateY(6px)";
    };
    const setZoomTo = (on: boolean) => {
      zoomTarget = on && hasInfo ? 1 : 0;
      setCard(on && hasInfo);
    };

    /* hover — re-dive whenever the pointer comes back (not mid-drag) */
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerenter", () => {
      if (mode !== "drag") setZoomTo(true);
    });
    canvas.addEventListener("pointerleave", () => {
      if (mode !== "drag") setZoomTo(false);
    });

    /* drag — grab anywhere, throw the planet both ways. Dragging resets
       the globe to NORMAL SIZE (zoom out + card hides) immediately.
       preventDefault + user-select:none stop the browser from hijacking
       the gesture for text selection — that pointercancel used to kill
       desktop drags a few pixels in. */
    let dragK = 0.009; // rad per px, set per-drag from the canvas width
    let dragId: number | null = null;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;
    let dragged = false;
    let velSample = 0;
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    (canvas.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = "none";
    canvas.addEventListener("dragstart", (e) => e.preventDefault());
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (dragId !== null) return;
        e.preventDefault();
        dragId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        lastT = e.timeStamp;
        dragged = false;
        velSample = 0;
        angVel = 0;
        mode = "drag";
        returning = false;
        returnAt = 0;
        dragK = 5.0 / Math.max(160, canvas.clientWidth || 210); // ~1.6 turns per canvas width
        setZoomTo(false); // back to normal size the moment it is grabbed
        canvas.style.cursor = "grabbing";
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* capture is best-effort */
        }
      },
    );
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== dragId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (dx === 0 && dy === 0) return;
      const dtMs = Math.max(1, e.timeStamp - lastT);
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = e.timeStamp;
      dragged = true;
      spin += dx * dragK; // both directions — no clamping on purpose
      rig.rotation.y = spin;
      camYOff = clamp(camYOff + dy * 0.0035, -0.12, 0.55);
      applyCamera();
      // smoothed release velocity for the fling (rad/s)
      const inst = ((dx * dragK) / dtMs) * 1000;
      velSample = velSample * 0.7 + inst * 0.3;
    });
    const endDrag = (e: PointerEvent) => {
      if (e.pointerId !== dragId) return;
      dragId = null;
      canvas.style.cursor = "grab";
      mode = "idle";
      if (dragged) {
        angVel = clamp(velSample, -5, 5); // the throw
        returnAt = performance.now() + 5000; // glide home soon
      }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("lostpointercapture", endDrag);

    let raf = 0;
    let last = 0;
    let lastW = 0;
    let lastH = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /** project the user marker to css px inside the wrap; null when off-face.
     *  The pin's location lives in its single GEOMETRY vertex (the Points
     *  object itself sits at the tilt origin) — read the vertex, then map it
     *  through the marker's own world matrix. */
    const projectMark = (mark: import("three").Points, w: number, h: number): { x: number; y: number } | null => {
      const attr = mark.geometry.getAttribute("position");
      if (!attr || attr.count < 1) return null;
      const v = new THREE.Vector3(attr.getX(0), attr.getY(0), attr.getZ(0));
      mark.localToWorld(v);
      // front-face check: marker direction vs camera direction
      const camDir = camera.position.clone().normalize();
      if (v.clone().normalize().dot(camDir) < 0.25) return null;
      v.project(camera);
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
    };

    const placeBubble = () => {
      if (!bubble || !userMark || !bubbleHost) return;
      const { w, h } = box();
      const pos = projectMark(userMark, w, h);
      if (!pos) {
        bubble.style.opacity = "0";
        return;
      }
      // the positioning host is the canvas's flex parent (right-aligned,
      // centered) — translate canvas-local px into host-local px
      const cr = canvas.getBoundingClientRect();
      const pr = bubbleHost.getBoundingClientRect();
      const ox = cr.left - pr.left;
      const oy = cr.top - pr.top;
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      // hover right NEXT to the marker: right of it, vertically centered,
      // clamped inside the canvas box
      let x = ox + pos.x + 16;
      if (x + bw > ox + w - 4) x = ox + pos.x - bw - 16; // flip left when crowded
      x = Math.max(ox + 4, Math.min(ox + w - bw - 4, x));
      const y = Math.max(oy + 4, Math.min(oy + h - bh - 4, oy + pos.y - bh / 2));
      bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      bubble.style.opacity = "1";
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !canvas.isConnected) return;
      const dt = last ? Math.min((now - last) / 1000, 0.12) : 0.016;
      last = now;

      /* keep the drawing buffer matched to the CSS box (the block can
         reflow — the canvas stretches to the weather text height) */
      const { w, h } = box();
      const resized = w !== lastW || h !== lastH;
      if (resized) {
        lastW = w;
        lastH = h;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }

      /* intro: settle the SHORT way to your spot (wrapPi picks the closer
         direction, so the planet may spin east or west — both ways) */
      if (mode === "intro") {
        const delta = wrapPi(target - spin);
        spin += delta * Math.min(1, dt * 2.6);
        rig.rotation.y = spin;
        if (Math.abs(delta) < HOLD_EPS) {
          spin = target;
          rig.rotation.y = spin;
          mode = "idle";
          setZoomTo(true); // the automatic dive + info card
        }
      }

      /* drag — decay the velocity sample so a hold-still release never
         flings: only movement in the last ~100ms before release counts */
      if (mode === "drag") {
        velSample *= Math.exp(-dt * 10);
      }

      /* idle — spin glides home whenever we owe the user the canonical
         frame: five seconds after a throw (returning) or while a dive is
         on (hover re-dive / the auto-dive), so the pin is framed on arrival */
      const wantHome = mode === "idle" && (returning || zoomTarget === 1);
      if (mode === "idle" && !returning && returnAt !== 0 && now >= returnAt) {
        returnAt = 0;
        returning = true;
        angVel = 0; // the glide-home owns the spin now
      }
      if (wantHome) {
        const delta = wrapPi(target - spin);
        // the view height (vertical drag) eases home with the spin, so the
        // resting frame is always the canonical one
        const yNext = camYOff + (0 - camYOff) * Math.min(1, dt * 1.8);
        if (Math.abs(yNext - camYOff) > 0.0004) {
          camYOff = yNext;
        } else {
          camYOff = 0;
        }
        if (Math.abs(delta) < HOLD_EPS && camYOff === 0) {
          spin = target;
          rig.rotation.y = spin;
          applyCamera();
          if (returning) returning = false;
        } else {
          spin += delta * Math.min(1, dt * 1.8);
          rig.rotation.y = spin;
          applyCamera();
        }
      } else if (mode === "idle" && Math.abs(angVel) > 0.02) {
        /* fling inertia — the throw keeps rolling, exponentially damped */
        spin += angVel * dt;
        angVel *= Math.exp(-dt * 3.4);
        rig.rotation.y = spin;
        applyCamera();
      }

      /* zoom easing — the dive (camera tracks the pin via applyCamera) */
      const zNext = zoom + (zoomTarget - zoom) * Math.min(1, dt * 3.2);
      const zooming = Math.abs(zNext - zoom) > 0.0004;
      if (zooming) {
        zoom = zNext;
        applyCamera();
      } else if (zoom !== zoomTarget) {
        zoom = zoomTarget;
        applyCamera();
      }

      const active =
        mode === "drag" || returning || zooming || resized || Math.abs(angVel) > 0.02;
      if (!reduced || active) {
        renderer.render(scene, camera);
        placeBubble();
      }
    };

    if (reduced) {
      // no choreography: start settled on your spot at normal size,
      // but dragging/hover still work (the loop renders only when active)
      spin = target;
      rig.rotation.y = spin;
      mode = "idle";
      applyCamera();
      const { w, h } = box();
      lastW = w;
      lastH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      placeBubble();
    }
    raf = requestAnimationFrame(frame);

    const dispose = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("murke-theme", onTheme);
      if (bubble) bubble.remove();
      if (card) card.remove();
      earth.geometry.dispose();
      earthMat.dispose();
      const map = earthMat.map;
      if (map) map.dispose();
      for (const m of [userMark, forecastMark]) {
        if (m) {
          m.geometry.dispose();
          (m.material as import("three").PointsMaterial).dispose();
        }
      }
      renderer.dispose();
      // release the WebGL slot NOW — remounts never exhaust the context pool
      renderer.forceContextLoss();
    };
    rigs.push({ canvas, dispose });
    pending.delete(canvas);
  })();
}
