import { useEffect, useRef } from 'react';

/** Banknote-style rosette drawn in the current brass colour; purely decorative. */
export function Guilloche({ x = 0.84, y = 0.46, scale = 1 }: { x?: number; y?: number; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const r = cv.getBoundingClientRect();
      const w = r.width, h = r.height;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = getComputedStyle(cv).getPropertyValue('--brass').trim() || '#c9a45a';
      ctx.lineWidth = 0.6;
      const cx = w * x, cy = h * y, S = (Math.min(w, h * 1.6) / 300) * scale;
      const rings: Array<[number, number, number, number]> = [[104, 9, 30, 0.28], [86, 11, 24, 0.22], [68, 13, 18, 0.16]];
      for (const [R, k, a, al] of rings) {
        ctx.globalAlpha = al;
        ctx.beginPath();
        for (let s = 0; s <= 1800; s++) {
          const t = (s / 1800) * Math.PI * 2;
          const rr = (R + a * Math.sin(k * t) * 0.45 + 5 * Math.cos((k + 4) * t)) * S;
          const px = cx + rr * Math.cos(t), py = cy + rr * Math.sin(t) * 0.86;
          if (s) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 0.12;
      for (let j = 0; j < 40; j++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, 54 * S, 16 * S, (j / 40) * Math.PI, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    const mo = new MutationObserver(draw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', draw);
    return () => { ro.disconnect(); mo.disconnect(); mq.removeEventListener('change', draw); };
  }, [x, y, scale]);

  return <canvas ref={ref} aria-hidden="true" />;
}
