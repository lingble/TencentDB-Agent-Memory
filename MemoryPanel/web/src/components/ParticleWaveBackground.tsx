/**
 * ParticleWaveBackground — bright-style dot-grid ripple animated background (pure Canvas, zero external dependencies).
 *
 * Visually inspired by React Bits' Particles / DotGrid: a grid of dots undulating under multiple layered sine waves,
 * with dot radius and opacity varying with the wave crests, forming soft "breathing" ripples.
 *
 * Why not just install the React Bits package:
 *   its Particles / DotGrid / Aurora depend on ogl / gsap / three respectively, none of which this project installs.
 *   Implemented the manual way React Bits officially recommends (copying source into the project), avoiding new runtime dependencies
 *   and build risk, while keeping full control over visual tuning.
 *
 * Implementation notes:
 *   - devicePixelRatio support, so it isn't blurry on high-DPI screens;
 *   - ResizeObserver follows the container size; window isn't listened to, so multiple instances don't interfere;
 *   - respects prefers-reduced-motion: renders a single static frame without starting rAF when reduced motion is preferred;
 *   - cancels rAF and the observer on unmount, no memory leaks.
 */
import { useEffect, useRef } from 'react';

export interface ParticleWaveBackgroundProps {
  /** Dot grid spacing (px); smaller is denser. Default 26 */
  gap?: number;
  /** Base dot radius (px). Default 1.5 */
  dotRadius?: number;
  /** Dot color, must be in `r, g, b` form (opacity is computed internally from the wave crest). Default dark gray-blue */
  color?: string;
  /** Animation speed factor, default 1 */
  speed?: number;
  /** Additional class name */
  className?: string;
}

export default function ParticleWaveBackground({
  gap = 26,
  dotRadius = 1.5,
  color = '100, 116, 139',
  speed = 1,
  className,
}: ParticleWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let width = 0;
    let height = 0;
    let disposed = false;

    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const parent = canvas!.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      // Use setTransform rather than scale, so the scale factor doesn't accumulate after repeated resizes
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * Render one frame. Three sine wave layers with different frequencies/phases are summed into an intensity field in [-1, 1];
     * intensity maps to dot radius and opacity, forming a dot-grid ripple of light and dark.
     *
     * About the parameter values: the time factor determines "how fast it looks like it's moving". When too small (<0.5) a single wave period lasts
     * over ten seconds, and the eye can barely tell it's moving - it looks like a still image; 0.65-1.15 here gives the main wave about a 5-second
     * period, clearly showing flow without being dizzying.
     */
    function draw(elapsedMs: number) {
      if (width <= 0 || height <= 0) return;
      const t = (elapsedMs / 1000) * speed;
      ctx!.clearRect(0, 0, width, height);

      const cols = Math.ceil(width / gap) + 1;
      const rows = Math.ceil(height / gap) + 1;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * gap;
          const y = row * gap;
          // Normalized coordinates keep the waveform from distorting with canvas size
          const nx = x / Math.max(width, 1);
          const ny = y / Math.max(height, 1);

          // The main wave flows right to left; the other two layers overlay at different angles to avoid regular stripes
          const wave =
            Math.sin(nx * 7.5 - t * 1.15) * 0.45 +
            Math.sin(ny * 5.5 + t * 0.75) * 0.28 +
            Math.sin((nx * 3.2 + ny * 4.1) + t * 0.95) * 0.27;

          // wave ∈ approx. [-1, 1] → intensity ∈ [0, 1]
          const intensity = (wave + 1) / 2;
          // A power curve compresses the darks, making crests stand out and troughs cleaner for sharper contrast
          const shaped = Math.pow(intensity, 1.4);
          // Slightly lighter at the top and denser at the bottom, enhancing the bright "light from above" feel
          const depth = 0.6 + ny * 0.4;
          const alpha = (0.08 + shaped * 0.5) * depth;
          const radius = dotRadius * (0.45 + shaped * 1.15);
          if (alpha <= 0.01 || radius <= 0.05) continue;

          ctx!.beginPath();
          ctx!.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
          ctx!.arc(x, y, radius, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
    }

    function loop(now: number) {
      if (disposed) return;
      draw(now);
      rafId = window.requestAnimationFrame(loop);
    }

    resize();

    const observer = new ResizeObserver(() => {
      resize();
      // When reduced motion is preferred rAF doesn't run, so a frame must be redrawn manually after resize
      if (reduceMotion) draw(0);
    });
    const parent = canvas.parentElement;
    if (parent) observer.observe(parent);

    if (reduceMotion) {
      draw(0);
    } else {
      rafId = window.requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [gap, dotRadius, color, speed]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
