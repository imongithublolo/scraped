"use client";

import { useEffect, useRef } from "react";
import type { ThemeName } from "@/lib/murke/contracts";
import { THEMES } from "@/lib/murke/themes";

/**
 * The living backdrops — every theme (except bare `minimal`) burns its own
 * three.js scene behind the glass, tinted from that theme's palette:
 *
 *   hell       FIRE        bottom-fed flames + rising embers
 *   amber      EMBERDUST   warm smoke banks + drifting sparks
 *   bone       BONEDUST    pale ash haze + bone-white motes
 *   void       BLACKHOLE   lensed starfield, photon ring, accretion disk
 *   toxic      ACIDRAIN    falling acid streaks + green fog
 *   blood      BLOODMOON   cratered red moon + drifting clouds
 *   frost      SNOWFALL    layered swaying snow + cold mist
 *   static     DEADSTATIC  fine TV noise + glitch bands + roll bar
 *   classic    NEBULA      violet nebula clouds + starfield
 *
 * Budget rules (this lives UNDER a text UI, it must never tax it):
 *  - renders at FULL window resolution (crisp scenes — was 0.5x, looked
 *    blurry; these are cheap fragment shaders, 30fps-capped anyway)
 *  - hard 30fps cap; the scenes drift, they don't need more
 *  - paused entirely while a murke overlay (browser/paint/chat/notes/video)
 *    is open (listens for the "murke-overlay" custom event dsh dispatches)
 *  - paused while the tab is hidden
 *  - prefers-reduced-motion: one static frame, no loop
 *  - three is dynamically imported so it never lands in the first-load bundle
 *  - every frame is calibrated DARK: the terminal text always wins
 */

const RES_SCALE = 1.0;
const FRAME_MS = 1000 / 30;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMMON = /* glsl */ `
uniform float uTime;
uniform vec2 uRes;
uniform vec3 uColA;   // brand — the hot/accent tone
uniform vec3 uColB;   // dim  — the deep tone
uniform vec3 uColC;   // hi   — the bright tone
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.55;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += amp * vnoise(p);
    p = rot * p * 2.02;
    amp *= 0.52;
  }
  return v;
}
float starLayer(vec2 p, float t) {
  vec2 g = floor(p);
  vec2 f = fract(p);
  float h = hash(g);
  vec2 c = vec2(0.15 + 0.7 * fract(h * 13.73), 0.15 + 0.7 * fract(h * 7.31));
  float d = length(f - c);
  float tw = 0.6 + 0.4 * sin(t * 1.5 + h * 40.0);
  return smoothstep(0.09, 0.0, d) * step(0.78, h) * tw;
}
`;

/* ---------------- hell: fire ---------------- */
const FRAG_FIRE = COMMON + /* glsl */ `
float flame(vec2 uv, float t) {
  uv.x *= 1.6;
  float sway = vnoise(vec2(uv.x * 2.0, t * 0.8)) * 0.22;
  uv.x -= sway * uv.y;
  float body = uv.y * 2.4 + fbm(uv * vec2(3.2, 2.1) + vec2(0.0, -t * 2.6)) * 1.55;
  return clamp(1.0 - body, 0.0, 1.0);
}
void main() {
  float t = uTime * 0.85;
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);

  vec3 col = vec3(0.012, 0.002, 0.004);

  // deep ember glow rising from the floor
  float glow = exp(-pow((uv.y - 0.02) * 2.6, 2.0));
  col += uColB * glow * 0.34;

  // the fire itself — three sheets for depth (near tall, mid, far low)
  float f1 = flame(p * vec2(1.0, 1.0) + vec2(0.0, 0.0), t);
  float f2 = flame(p * vec2(1.9, 0.72) + vec2(4.7, 0.3), t * 1.35);
  float f3 = flame(p * vec2(3.1, 0.5) + vec2(9.1, 0.6), t * 1.7);
  float fire = clamp(f1 * 1.2 + f2 * 0.66 + f3 * 0.42, 0.0, 1.0);
  vec3 fireCol = mix(uColB, uColA, clamp(fire * 1.6, 0.0, 1.0));
  fireCol = mix(fireCol, uColC, clamp(fire * fire * 1.9 - 0.32, 0.0, 1.0));
  col += fireCol * fire * 0.72;

  // heat haze up top
  col += uColB * fbm(p * 3.0 + vec2(t * 0.12, -t * 0.2)) * 0.06 * smoothstep(0.2, 1.0, uv.y);

  // keep the floor dark so terminal text always wins
  col *= 0.64;
  col *= 1.0 - 0.30 * smoothstep(0.1, 0.9, uv.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- amber / bone: drifting dust ---------------- */
const FRAG_ASH = COMMON + /* glsl */ `
void main() {
  float t = uTime * 0.22;
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  vec3 col = vec3(0.006, 0.004, 0.003);

  // slow smoke banks — two warping octaves for real depth
  float smoke = fbm(p * 2.4 + vec2(t * 0.55, -t * 0.22));
  smoke = pow(smoke, 1.6);
  float smoke2 = fbm(p * 4.3 + vec2(-t * 0.4, t * 0.16) + smoke * 0.9);
  col += mix(uColB, uColA, smoke * 0.7) * smoke * 0.32;
  col += mix(uColB, uColC, smoke2 * 0.5) * smoke2 * 0.10;

  // a low source-glow (ember bed for amber, cold shine for bone)
  float bed = exp(-pow((uv.y - 0.04) * 3.4, 2.0));
  col += uColA * bed * 0.16;

  // floating motes — two parallax sheets drifting up-left
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec2 mp = vec2(p.x * (5.0 + fi * 4.0), p.y * (5.0 + fi * 4.0)) + vec2(t * (0.8 + fi), t * (0.5 + fi * 0.7));
    vec2 g = fract(mp) - 0.5;
    float h = hash(floor(mp) + fi * 7.1);
    float mote = smoothstep(0.085, 0.0, length(g)) * step(0.93, h);
    col += mix(uColA, uColC, h) * mote * (0.35 - fi * 0.12) * (0.6 + 0.4 * sin(t * 8.0 + h * 60.0));
  }

  col *= 0.58;
  col *= 1.0 - 0.30 * smoothstep(0.1, 0.9, uv.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- void: black hole ---------------- */
const FRAG_BLACKHOLE = COMMON + /* glsl */ `
void main() {
  float t = uTime * 0.4;
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  vec2 c = vec2(0.0, 0.06);          // singularity sits a touch above center
  vec2 q = p - c;
  float r = length(q);

  /* gravitational lensing: space bends toward the hole, then swirls */
  float lens = 0.010 / max(r, 0.02);
  float ang = 0.9 * lens + t * 0.10;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 sp = rot * (q * (1.0 - lens));

  /* deep space + lensed starfield */
  vec3 col = vec3(0.003, 0.002, 0.006);
  float s1 = starLayer(sp * 9.0 + 3.1, uTime);
  float s2 = starLayer(sp * 17.0 + 7.7, uTime * 1.35);
  col += vec3(0.80, 0.76, 0.92) * s1 * 0.42;
  col += vec3(0.55, 0.48, 0.78) * s2 * 0.28;

  /* faint violet nebula, itself warped by the lens */
  float neb = fbm(sp * 2.1 + vec2(t * 0.05, -t * 0.035));
  col += vec3(0.045, 0.010, 0.075) * neb;

  /* accretion disk — squashed ellipse, hot inner edge, doppler side-glow */
  vec2 dq = q;
  dq.y *= 2.75;
  float dr = length(dq);
  float diskAng = atan(dq.y, dq.x);
  float band = exp(-pow((dr - 0.155) * 8.5, 2.0));
  float swirl = fbm(vec2(diskAng * 2.4 + t * 0.7, dr * 20.0 - t * 0.45));
  float doppler = 1.0 + 0.6 * sin(diskAng - 0.6);
  float disk = band * (0.30 + 0.90 * swirl);
  vec3 hot = mix(vec3(0.98, 0.86, 1.0), uColC, 0.4);
  vec3 cool = mix(vec3(0.30, 0.08, 0.52), uColB, 0.4);
  col += mix(cool, hot, clamp(disk * doppler * 1.35, 0.0, 1.0)) * disk * doppler * 0.42;

  /* photon ring — razor thin, brighter approaching the doppler side */
  float pr = smoothstep(0.013, 0.004, abs(r - 0.045));
  col += vec3(1.0, 0.92, 1.0) * pr * (0.55 + 0.25 * sin(diskAng - 0.6));

  /* event horizon — absolute black, hard edge */
  col *= smoothstep(0.030, 0.041, r);

  /* keep the floor dark so terminal text always wins */
  col *= 0.52;
  col *= 1.0 - 0.38 * smoothstep(0.15, 0.85, uv.y);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- toxic: acid rain ---------------- */
const FRAG_RAIN = COMMON + /* glsl */ `
float rainLayer(vec2 uv, float scale, float speed, float t) {
  uv *= scale;
  uv.y += t * speed;
  vec2 g = vec2(floor(uv.x), fract(uv.y));
  float h = hash(vec2(floor(uv.x), floor(uv.y * 0.08)));
  float streak = smoothstep(0.5, 0.0, abs(g.x - 0.5)) * step(0.6, h);
  float drop = smoothstep(0.55, 0.0, abs(g.y - 0.5)) * streak;
  return drop * step(0.35, h);
}
void main() {
  float t = uTime;
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);

  vec3 col = vec3(0.002, 0.006, 0.003);

  // fog banks crawling sideways
  float fog = fbm(vec2(p.x * 1.8 + t * 0.06, p.y * 2.6 - t * 0.03));
  col += uColB * fog * 0.22;

  // three rain sheets — near fast, far slow
  float r1 = rainLayer(p * vec2(1.0, 1.0) + vec2(0.0, 0.0), 26.0, 1.6, t);
  float r2 = rainLayer(p * vec2(1.0, 1.0) + vec2(3.3, 0.7), 17.0, 1.0, t * 0.9);
  float r3 = rainLayer(p * vec2(1.0, 1.0) + vec2(8.1, 0.2), 9.0, 0.55, t * 0.8);
  col += uColA * r1 * 0.34;
  col += mix(uColA, uColC, 0.5) * r2 * 0.22;
  col += uColB * r3 * 0.30;

  // ground splashes — a faint breathing band at the floor
  float splash = exp(-pow((uv.y - 0.05) * 9.0, 2.0));
  col += uColA * splash * (0.06 + 0.03 * sin(t * 2.2));

  // toxic starfield behind everything
  col += uColC * starLayer(p * 11.0 + 2.2, uTime) * 0.05;

  col *= 0.60;
  col *= 1.0 - 0.32 * smoothstep(0.1, 0.9, uv.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- blood: blood moon ---------------- */
const FRAG_MOON = COMMON + /* glsl */ `
void main() {
  float t = uTime * 0.15;
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  vec3 col = vec3(0.010, 0.001, 0.002);

  // the moon, hanging upper-right
  vec2 mc = vec2(0.34, 0.30);
  float mr = length((p - mc) * vec2(1.0, 1.0));
  float disc = smoothstep(0.155, 0.148, mr);
  float halo = exp(-pow(max(mr - 0.15, 0.0) * 7.0, 1.6));

  // cratered surface
  float craters = fbm((p - mc) * 16.0 + 3.7);
  float mare = fbm((p - mc) * 5.5 + 9.1);
  float surf = 0.55 + 0.45 * craters;
  surf *= 0.75 + 0.35 * mare;

  col += mix(uColB, uColA, surf) * disc * surf * 0.85;
  col += uColB * halo * 0.20;
  col += uColA * smoothstep(0.150, 0.148, mr) * 0.10; // thin rim

  // drifting clouds crossing the disc
  float cl = fbm(vec2(p.x * 2.3 + t * 0.7, p.y * 3.4 - t * 0.18));
  cl = smoothstep(0.45, 0.75, cl);
  col *= 1.0 - cl * 0.55;
  col += uColB * cl * 0.10;

  // blood haze over everything
  col += uColB * fbm(p * 1.6 + vec2(t * 0.3, 0.0)) * 0.06;

  col *= 0.62;
  col *= 1.0 - 0.30 * smoothstep(0.1, 0.9, uv.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- frost: snowfall ---------------- */
const FRAG_SNOW = COMMON + /* glsl */ `
float snowLayer(vec2 uv, float scale, float speed, float sway, float t) {
  vec2 p = uv * scale;
  p.y += t * speed;
  p.x += sin(t * 0.5 + p.y * 0.35) * sway;
  vec2 g = fract(p) - 0.5;
  float h = hash(floor(p));
  float flake = smoothstep(0.16, 0.0, length(g));
  return flake * step(0.72, h);
}
void main() {
  float t = uTime * 0.55;
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  vec3 col = vec3(0.002, 0.004, 0.006);

  // cold mist banks
  float mist = fbm(p * 2.1 + vec2(t * 0.18, -t * 0.1));
  col += uColB * mist * 0.26;

  // aurora band up top
  float band = exp(-pow((uv.y - 0.82 + 0.06 * sin(p.x * 3.0 + t * 0.7)) * 5.0, 2.0));
  col += uColA * band * (0.10 + 0.06 * fbm(vec2(p.x * 4.0, t * 0.4)));

  // three snow sheets
  float s1 = snowLayer(p * vec2(1.0, 1.0) + vec2(0.0, 0.0), 22.0, 0.65, 0.35, t);
  float s2 = snowLayer(p * vec2(1.0, 1.0) + vec2(5.2, 0.4), 14.0, 0.42, 0.5, t * 0.92);
  float s3 = snowLayer(p * vec2(1.0, 1.0) + vec2(9.7, 0.9), 8.0, 0.26, 0.6, t * 0.85);
  col += uColC * s1 * 0.20;
  col += mix(uColA, uColC, 0.6) * s2 * 0.16;
  col += uColB * s3 * 0.24;

  col *= 0.60;
  col *= 1.0 - 0.30 * smoothstep(0.1, 0.9, uv.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- static: dead channel ---------------- */
const FRAG_STATIC = COMMON + /* glsl */ `
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float t = uTime;
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);

  // fine static — two scales of raw noise
  float px = floor(uv * uRes * 0.5);
  float n1 = hash21(px + floor(t * 24.0));
  float n2 = hash21(floor(uv * vec2(aspect, 1.0) * 90.0) + floor(t * 12.0) * 0.37);
  float noise = n1 * 0.65 + n2 * 0.35;

  vec3 col = vec3(0.008) + vec3(noise * 0.05);

  // horizontal glitch bands — displaced rows that flicker
  float row = floor(uv.y * 46.0);
  float gh = hash21(vec2(row, floor(t * 7.0)));
  float bandOn = step(0.93, gh) * (0.5 + 0.5 * hash21(vec2(row, floor(t * 22.0))));
  col += uColA * bandOn * 0.10;

  // the roll bar — a bright band crawling down like a dying tube
  float roll = fract(t * 0.13);
  float bar = exp(-pow((uv.y - roll) * 26.0, 2.0));
  col += vec3(0.9) * bar * 0.05;

  // phosphor tint, heavier in the dark rows
  col += uColB * noise * 0.05;

  col *= 0.55;
  col *= 1.0 - 0.30 * smoothstep(0.1, 0.9, uv.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- classic: violet nebula ---------------- */
const FRAG_NEBULA = COMMON + /* glsl */ `
void main() {
  float t = uTime * 0.10;
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  vec3 col = vec3(0.004, 0.003, 0.008);

  // starfield, three depths
  col += vec3(0.85, 0.82, 0.95) * starLayer(p * 10.0 + 1.7, uTime) * 0.24;
  col += vec3(0.60, 0.52, 0.80) * starLayer(p * 19.0 + 6.3, uTime * 1.3) * 0.14;
  col += vec3(0.95, 0.90, 1.0) * starLayer(p * 31.0 + 11.1, uTime * 1.6) * 0.08;

  // the nebula — layered fbm clouds, violet core with hi rim light
  float n1 = fbm(p * 2.0 + vec2(t * 0.6, -t * 0.35));
  float n2 = fbm(p * 3.7 - vec2(t * 0.4, t * 0.28) + n1 * 0.8);
  float clouds = pow(clamp(n1 * 0.75 + n2 * 0.45, 0.0, 1.0), 1.7);
  col += mix(uColB, uColA, clouds) * clouds * 0.44;
  col += uColC * pow(clouds, 3.0) * 0.18;

  // the bright heart of the nebula
  float core = exp(-dot(p - vec2(0.05, 0.02), p - vec2(0.05, 0.02)) * 2.6);
  col += mix(uColA, uColC, 0.55) * core * clouds * 0.16;

  col *= 0.58;
  col *= 1.0 - 0.32 * smoothstep(0.12, 0.9, uv.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

function fragFor(kind: string): string {
  switch (kind) {
    case "fire":
      return FRAG_FIRE;
    case "emberdust":
    case "bonedust":
      return FRAG_ASH;
    case "blackhole":
      return FRAG_BLACKHOLE;
    case "acidrain":
      return FRAG_RAIN;
    case "bloodmoon":
      return FRAG_MOON;
    case "snowfall":
      return FRAG_SNOW;
    case "deadstatic":
      return FRAG_STATIC;
    case "nebula":
      return FRAG_NEBULA;
    default:
      return "";
  }
}

function hexToVec3(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export default function ThemeBackground({ theme }: { theme: ThemeName }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const def = THEMES[theme];
    const kind = def.bgKind;
    const frag = fragFor(kind);
    const canvas = canvasRef.current;
    if (kind === "none" || !frag || !canvas) return;
    let dead = false;
    let teardown: (() => void) | null = null;

    void (async () => {
      const THREE = await import("three");
      if (dead || !canvas.isConnected) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: false,
          alpha: false,
          powerPreference: "low-power",
        });
      } catch {
        return; // no webgl — terminal just stays on solid bg
      }
      renderer.setPixelRatio(1);

      const uniforms = {
        uTime: { value: 7.0 },
        uRes: { value: new THREE.Vector2(2, 2) },
        uColA: { value: new THREE.Vector3(...hexToVec3(def.brand)) },
        uColB: { value: new THREE.Vector3(...hexToVec3(def.dim)) },
        uColC: { value: new THREE.Vector3(...hexToVec3(def.hi)) },
      };
      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: frag,
        depthTest: false,
        depthWrite: false,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      quad.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(quad);
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      const resize = () => {
        const w = Math.max(2, Math.floor(window.innerWidth * RES_SCALE));
        const h = Math.max(2, Math.floor(window.innerHeight * RES_SCALE));
        renderer.setSize(w, h, false);
        uniforms.uRes.value.set(w, h);
      };
      resize();
      window.addEventListener("resize", resize);

      /* pause while any murke overlay owns the screen */
      let overlayOpen = false;
      const onOverlay = (e: Event) => {
        overlayOpen = Boolean((e as CustomEvent<{ open?: boolean }>).detail?.open);
      };
      window.addEventListener("murke-overlay", onOverlay);

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      let raf = 0;
      let simT = 7.0;
      let lastNow = 0;
      let acc = 0;

      const renderOnce = () => {
        uniforms.uTime.value = simT;
        renderer.render(scene, camera);
      };

      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const dt = lastNow ? Math.min(now - lastNow, 120) : FRAME_MS;
        lastNow = now;
        if (overlayOpen || document.hidden) return;
        acc += dt;
        if (acc < FRAME_MS) return;
        simT += Math.min(acc, 100) / 1000;
        acc = 0;
        renderOnce();
      };

      if (reduced) {
        renderOnce();
      } else {
        renderOnce();
        raf = requestAnimationFrame(frame);
      }

      teardown = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", resize);
        window.removeEventListener("murke-overlay", onOverlay);
        quad.geometry.dispose();
        material.dispose();
        renderer.dispose();
      };
    })();

    return () => {
      dead = true;
      teardown?.();
    };
  }, [theme]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
      aria-hidden="true"
    />
  );
}
