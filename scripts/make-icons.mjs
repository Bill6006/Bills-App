// Renders the app icons with the bundled Bodoni Moda font in headless Chromium.
// Usage: node scripts/make-icons.mjs   (writes PNGs into public/icons/)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fontFile = path.join(root, 'node_modules/@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-opsz-normal.woff2');
const fontData = 'data:font/woff2;base64,' + fs.readFileSync(fontFile).toString('base64');

const page = (size, { safe = 1, radius = 0 } = {}) => `<!doctype html><html><head><style>
@font-face{font-family:BM;src:url('${fontData}') format('woff2');font-weight:400 900}
html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
.c{position:relative;width:${size}px;height:${size}px;border-radius:${radius}px;overflow:hidden;
  background:radial-gradient(120% 120% at 30% 20%, #1C2C24 0%, #101A15 55%, #0A110E 100%)}
canvas{position:absolute;inset:0}
.b{position:absolute;inset:0;display:grid;place-items:center;font-family:BM;font-weight:640;
  font-variation-settings:'opsz' 96;color:#D9B66C;font-size:${Math.round(size * 0.6 * safe)}px;line-height:1;
  padding-bottom:${Math.round(size * 0.03 * safe)}px;text-shadow:0 ${Math.max(1, size / 128)}px ${size / 40}px rgba(0,0,0,.35)}
</style></head><body><div class="c"><canvas id="g" width="${size * 2}" height="${size * 2}" style="width:${size}px;height:${size}px"></canvas><div class="b">B</div></div>
<script>
const cv=document.getElementById('g'),x=cv.getContext('2d'),S=${size}*2,s=${safe};
x.translate(S/2,S/2);x.strokeStyle='#D9B66C';x.lineWidth=S/700;
const R=S*0.40*s;
for(const [k,a,al] of [[9,0.10,.30],[11,0.08,.22],[13,0.06,.16]]){x.globalAlpha=al;x.beginPath();
 for(let i=0;i<=2400;i++){const t=i/2400*Math.PI*2;const r=R*(1+a*Math.sin(k*t))*(1-(k-9)*0.06);const px=r*Math.cos(t),py=r*Math.sin(t);i?x.lineTo(px,py):x.moveTo(px,py);}x.stroke();}
x.globalAlpha=.10;for(let j=0;j<48;j++){x.beginPath();x.ellipse(0,0,R*0.98,R*0.30,j/48*Math.PI,0,Math.PI*2);x.stroke();}
</script></body></html>`;

const out = path.join(root, 'public/icons');
const browser = await chromium.launch();
const shots = [
  ['icon-512.png', 512, { radius: 112 }],
  ['icon-192.png', 192, { radius: 42 }],
  ['icon-maskable-512.png', 512, { safe: 0.78 }],
  ['apple-touch-icon.png', 180, {}],
  ['favicon-48.png', 48, { radius: 11 }],
];
for (const [name, size, opts] of shots) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(page(size, opts));
  await p.evaluate(async () => { await document.fonts.load("640 100px BM"); await document.fonts.ready; });
  const ok = await p.evaluate(() => document.fonts.check("640 100px BM"));
  if (!ok) throw new Error('Bodoni Moda failed to load for ' + name);
  await p.waitForTimeout(150);
  await p.screenshot({ path: path.join(out, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await p.close();
}
await browser.close();
console.log('icons written to', out);
