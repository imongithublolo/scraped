"use client";

import { useEffect, useRef } from "react";

/**
 * Hellfire backdrop — a single fullscreen shader quad behind the terminal.
 *
 * Budget rules (this lives UNDER a text UI, it must never tax it):
 *  - renders at 0.5x resolution and lets CSS upscale (fire is soft anyway)
 *  - hard 30fps cap; fire drifts, it doesn't need more
 *  - paused entirely while a murke overlay (browser/paint/chat) is open
 *    (listens for the "murke-overlay" custom event dsh dispatches)
 *  - paused while the tab is hidden
 *  - prefers-reduced-motion: one static frame, no loop
 *  - three is dynamically imported so it never lands in the first-load bundle
 */

const RES_SCALE = 0.5;
const FRAME_MS = 1000 / 30;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uRes;
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
    p = rot * p * 2.02 + vec2(0.0, -uTime * 0.12);
    amp *= 0.52;
  }
  return v;
}

void main() {
  float t = uTime;
  vec2 uv = vUv;
  vec2 p = uv;
  p.x *= uRes.x / max(uRes.y, 1.0);

  float drift = t * 0.85;

  // rising, domain-warped turbulence
  vec2 q = vec2(p.x * 1.7, p.y * 2.6 - drift);
  float w = fbm(q * 1.3 + vec2(0.0, -drift * 0.55));
  float f = fbm(q * 2.15 + vec2(w * 1.35, -drift * 0.3));

  // vertical falloff — hottest at the base, gone by the top
  float fall = pow(1.0 - smoothstep(0.0, 1.02, uv.y), 1.35);

  float heat = f * fall * 2.0 - 0.22;
  heat = clamp(heat, 0.0, 1.0);
  heat = heat * heat;

  // blood -> ember -> gold ramp
  vec3 col = vec3(0.012, 0.0, 0.004);
  col = mix(col, vec3(0.17, 0.008, 0.012), smoothstep(0.02, 0.32, heat));
  col = mix(col, vec3(0.63, 0.05, 0.028), smoothstep(0.32, 0.60, heat));
  col = mix(col, vec3(1.0, 0.33, 0.06), smoothstep(0.60, 0.84, heat));
  col = mix(col, vec3(1.0, 0.83, 0.42), smoothstep(0.84, 0.99, heat));

  // drifting ember dust
  float sp = fbm(vec2(p.x * 5.5, p.y * 4.5 - t * 1.9) + 37.2);
  float spMask = smoothstep(0.74, 0.93, sp)
    * fall
    * smoothstep(0.06, 0.3, uv.y)
    * (1.0 - smoothstep(0.45, 0.85, uv.y));
  col += vec3(1.0, 0.55, 0.22) * spMask * 0.3;

  // keep the upper text zone calm, overall restrained — it's a backdrop
  col *= (1.0 - 0.5 * smoothstep(0.3, 0.95, uv.y)) * 0.88;

  gl_FragColor = vec4(col, 1.0);
}
`;

export default function FireBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
      };
      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
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

      /* pause while any murke overlay (browser/paint/chat) is open */
      let overlayOpen = false;
      const onOverlay = (e: Event) => {
        overlayOpen = Boolean((e as CustomEvent<{ open?: boolean }>).detail?.open);
      };
      window.addEventListener("murke-overlay", onOverlay);

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      let raf = 0;
      let simT = 7.0; // start mid-flame so the first frame already looks alive
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
        renderOnce(); // one still frame of embers, no loop
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
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
      aria-hidden="true"
    />
  );
}
