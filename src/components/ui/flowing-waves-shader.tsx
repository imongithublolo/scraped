"use client";

/**
 * InteractiveWaveShader — a full-bleed flowing-water shader (three.js).
 *
 * A single orthographic plane runs a classic interference-wave fragment
 * shader: dark water sliced by bright travelling crests. Originally built
 * as a reminders ambient layer (blue = active, green = upcoming); frost
 * mounts it behind the native search results as the water the glass
 * panel floats on.
 *
 * `paused` freezes the render loop (the last frame stays) so a
 * backgrounded copy costs no GPU.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

interface InteractiveWaveShaderProps {
  hasActiveReminders?: boolean;
  hasUpcomingReminders?: boolean;
  disableCenterDimming?: boolean;
  /** stop the animation loop (keeps the last frame on screen) */
  paused?: boolean;
}

const InteractiveWaveShader = ({
  hasActiveReminders = false,
  hasUpcomingReminders = false,
  disableCenterDimming = false,
  paused = false,
}: InteractiveWaveShaderProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const tickRef = useRef<(() => void) | null>(null);

  // Update shader uniforms when props change
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.hasActiveReminders.value = hasActiveReminders;
    }
  }, [hasActiveReminders]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.hasUpcomingReminders.value = hasUpcomingReminders;
    }
  }, [hasUpcomingReminders]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.disableCenterDimming.value = disableCenterDimming;
    }
  }, [disableCenterDimming]);

  // pause / resume the render loop without tearing the context down
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setAnimationLoop(paused ? null : tickRef.current);
    return () => renderer.setAnimationLoop(null);
  }, [paused]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 1) Renderer + Scene + Camera + Clock
    let renderer: THREE.WebGLRenderer;
    try {
      // Use alpha:false for a standard opaque background
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(window.devicePixelRatio);
      container.appendChild(renderer.domElement);
    } catch (err) {
      console.error("WebGL not supported", err);
      container.innerHTML =
        '<p style="color:white;text-align:center;">Sorry, WebGL isn’t available.</p>';
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // (three r186 deprecates THREE.Clock — a plain monotonic clock does
    //  the same job with a clean console)
    const t0 = performance.now();

    // 2) Shaders
    const vertexShader = `
      // We pass the UV coordinates of the plane to the fragment shader
      varying vec2 vTextureCoord;
      void main() {
        vTextureCoord = uv;
        gl_Position = vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      precision mediump float;
      uniform vec2 iResolution;
      uniform float iTime;
      uniform vec2 iMouse;
      uniform bool hasActiveReminders;
      uniform bool hasUpcomingReminders;
      uniform bool disableCenterDimming;
      varying vec2 vTextureCoord;

      void mainImage(out vec4 fragColor, in vec2 fragCoord) {
        vec2 uv = (2.0 * fragCoord - iResolution.xy) / min(iResolution.x, iResolution.y);

        // Calculate distance from center for dimming the center
        vec2 center = iResolution.xy * 0.5;
        float dist = distance(fragCoord, center);
        float radius = min(iResolution.x, iResolution.y) * 0.5;

        // Create a dimming factor for the center area (30% of the radius)
        float centerDim = disableCenterDimming ? 1.0 : smoothstep(radius * 0.3, radius * 0.5, dist);

        for(float i = 1.0; i < 10.0; i++){
          uv.x += 0.6 / i * cos(i * 2.5 * uv.y + iTime);
          uv.y += 0.6 / i * cos(i * 1.5 * uv.x + iTime);
        }

        // Determine color based on reminder state
        if (hasActiveReminders) {
          // Blue shade for active reminders
          fragColor = vec4(vec3(0.1, 0.3, 0.6) / abs(sin(iTime - uv.y - uv.x)), 1.0);
        } else if (hasUpcomingReminders) {
          // Green shade for upcoming reminders
          fragColor = vec4(vec3(0.1, 0.5, 0.2) / abs(sin(iTime - uv.y - uv.x)), 1.0);
        } else {
          // frost blue — the icy brand water (deep #1a5db8-ish troughs,
          // bright crests where the interference adds up)
          fragColor = vec4(vec3(0.13, 0.38, 0.72) / abs(sin(iTime - uv.y - uv.x)), 1.0);
        }

        // Apply center dimming only if not disabled
        if (!disableCenterDimming) {
          fragColor.rgb = mix(fragColor.rgb * 0.3, fragColor.rgb, centerDim);
        }
      }

      void main() {
        // Remove the circular mask to make the shader full screen
        vec4 color;
        mainImage(color, vTextureCoord * iResolution);
        gl_FragColor = color;
      }
    `;

    // 3) Material, Geometry, Mesh
    const uniforms = {
      iTime: { value: 0 },
      iResolution: { value: new THREE.Vector2() },
      iMouse: { value: new THREE.Vector2() },
      hasActiveReminders: { value: hasActiveReminders },
      hasUpcomingReminders: { value: hasUpcomingReminders },
      disableCenterDimming: { value: disableCenterDimming },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
    });
    materialRef.current = material; // Store material in ref
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    // 4) Resize and Mouse Move Handlers
    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      uniforms.iResolution.value.set(w, h);
    };

    const onMouseMove = (event: MouseEvent) => {
      uniforms.iMouse.value.set(event.clientX, event.clientY);
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMouseMove);
    onResize();

    // 5) Animation Loop
    const tick = () => {
      uniforms.iTime.value = (performance.now() - t0) / 1000;
      renderer.render(scene, camera);
    };
    tickRef.current = tick;
    rendererRef.current = renderer;
    if (!paused) renderer.setAnimationLoop(tick);

    // 6) Cleanup
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMouseMove);
      renderer.setAnimationLoop(null);
      tickRef.current = null;
      rendererRef.current = null;
      const canvas = renderer.domElement;
      if (canvas && canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
      material.dispose();
      geometry.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: "#000",
      }}
      aria-label="Interactive wave animation"
    />
  );
};

export default InteractiveWaveShader;
