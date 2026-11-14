'use strict';

/**
 * Генератор абстрактных обложек без внешних зависимостей.
 * Рисует сцены по пикселям и кодирует настоящие PNG (собственный энкодер на zlib).
 * Результат: ../images/*.png + ../images/manifest.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'images');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------------ PNG --- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- helpers --- */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
const sstep = (e0, e1, x) => smooth((x - e0) / (e1 - e0 || 1e-6));

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/* ------------------------------------------------------------- accents --- */

/**
 * @returns {number} alpha 0..1 for one accent at pixel (x, y)
 */
function accentAlpha(acc, x, y, u, v, W, H, minDim) {
  if (acc.type === 'rings' || acc.type === 'arc') {
    const dx = x - acc.cx * W;
    const dy = y - acc.cy * H;
    const d = Math.sqrt(dx * dx + dy * dy) / minDim;
    const r0 = acc.r0 ?? 0.05;
    const rmax = acc.rmax ?? 0.9;
    if (d < r0 - 0.02 || d > rmax + 0.02) return 0;

    let angular = 1;
    if (acc.type === 'arc') {
      const a = Math.atan2(dy, dx);
      const a0 = acc.a0 ?? 0;
      const a1 = acc.a1 ?? Math.PI;
      let delta = a - a0;
      const twoPi = Math.PI * 2;
      delta = ((delta % twoPi) + twoPi) % twoPi;
      let span = a1 - a0;
      span = ((span % twoPi) + twoPi) % twoPi;
      const edge = 0.03;
      angular = sstep(0, edge, delta) * (1 - sstep(span - edge, span, delta));
      if (angular <= 0) return 0;
    }

    const step = acc.step ?? 0.06;
    const phase = (((d - r0) % step) + step) % step;
    const dist = Math.min(phase, step - phase) * minDim;
    const lineW = acc.width ?? 1.2;
    const line = 1 - sstep(lineW, lineW + 1.4, dist);
    if (line <= 0) return 0;
    const fade = sstep(r0, r0 + 0.06, d) * (1 - sstep(rmax - 0.12, rmax, d));
    return line * fade * angular;
  }

  if (acc.type === 'dots') {
    const spacing = acc.spacing ?? 18;
    const ox = acc.cx * W;
    const oy = acc.cy * H;
    let gx = (x - ox) % spacing;
    let gy = (y - oy) % spacing;
    if (gx < 0) gx += spacing;
    if (gy < 0) gy += spacing;
    gx -= spacing / 2;
    gy -= spacing / 2;
    const d = Math.sqrt(gx * gx + gy * gy);
    const radius = acc.radius ?? 1.1;
    const dot = 1 - sstep(radius, radius + 1.3, d);
    if (dot <= 0) return 0;
    const mx = acc.mx ?? 0.5;
    const my = acc.my ?? 0.5;
    const mr = acc.mr ?? 0.5;
    const md = Math.sqrt((u - mx) ** 2 + (v - my) ** 2) / mr;
    const mask = 1 - sstep(0.35, 1, md);
    return dot * mask;
  }

  if (acc.type === 'lines') {
    const angle = acc.angle ?? 0.6;
    const spacing = acc.spacing ?? 60;
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    const proj = x * nx + y * ny;
    let ph = proj % spacing;
    if (ph < 0) ph += spacing;
    const dist = Math.min(ph, spacing - ph);
    const width = acc.width ?? 1;
    const line = 1 - sstep(width, width + 1.2, dist);
    if (line <= 0) return 0;
    if (!acc.mask) return line;
    const md = Math.sqrt((u - acc.mask.x) ** 2 + (v - acc.mask.y) ** 2) / acc.mask.r;
    return line * (1 - sstep(0.35, 1, md));
  }

  if (acc.type === 'waves') {
    const count = acc.count ?? 4;
    const gap = acc.gap ?? 0.08;
    const amp = acc.amp ?? 0.03;
    const freq = acc.freq ?? 1.5;
    const phase = acc.phase ?? 0;
    const thickness = acc.thickness ?? 1.2;
    let alpha = 0;
    for (let i = 0; i < count; i++) {
      const cy = (acc.y + i * gap) * H + Math.sin(u * Math.PI * 2 * freq + i * 1.8 + phase) * amp * minDim;
      const d = Math.abs(y - cy);
      const line = 1 - sstep(thickness, thickness + 1.4, d);
      if (line > alpha) alpha = line * (1 - (i / count) * (acc.fadeOut ?? 0.5));
    }
    return alpha;
  }

  return 0;
}

/* --------------------------------------------------------------- scene --- */

function render(scene) {
  const { width: W, height: H, palette, seed } = scene;
  const cols = palette.map(hexToRgb);
  const rnd = mulberry32(seed);
  const buffer = Buffer.alloc(W * H * 3);
  const grain = mulberry32(seed ^ 0x9e3779b9);
  const minDim = Math.min(W, H);

  const baseAngle = scene.baseAngle ?? 0.55;
  const ca = Math.cos(baseAngle);
  const sa = Math.sin(baseAngle);
  const projMin = Math.min(0, ca) + Math.min(0, sa);
  const projMax = Math.max(0, ca) + Math.max(0, sa);
  const projRange = projMax - projMin;

  const glows = (scene.glows ?? []).map((g) => ({
    x: g.x,
    y: g.y,
    r: g.r,
    strength: g.strength,
    k: g.k ?? 1.6,
    color: hexToRgb(g.color),
  }));

  const accents = (scene.accents ?? []).map((a) => ({
    ...a,
    rgb: hexToRgb(a.color ?? '#ffffff'),
    alpha: a.alpha ?? 0.2,
    mode: a.mode ?? 'screen',
  }));

  const spheres = (scene.spheres ?? []).map((s) => ({
    ...s,
    deep: hexToRgb(s.deep),
    bright: hexToRgb(s.bright),
    rim: hexToRgb(s.rim ?? '#ffffff'),
  }));

  // Свет для сфер: сверху-слева, чуть спереди.
  const Lx = -0.45, Ly = -0.55, Lz = 0.7;
  const Hx = Lx / Math.sqrt(Lx * Lx + Ly * Ly + (Lz + 1) ** 2);
  const Hy = Ly / Math.sqrt(Lx * Lx + Ly * Ly + (Lz + 1) ** 2);
  const Hz = (Lz + 1) / Math.sqrt(Lx * Lx + Ly * Ly + (Lz + 1) ** 2);

  const accentLimit = Math.max(0.1, (scene.accentFalloff ?? 1.0) * minDim);

  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);

      const t = smooth((u * ca + v * sa - projMin) / projRange);
      let r = cols[0][0] + (cols[1][0] - cols[0][0]) * t;
      let g = cols[0][1] + (cols[1][1] - cols[0][1]) * t;
      let b = cols[0][2] + (cols[1][2] - cols[0][2]) * t;

      for (const glow of glows) {
        const dx = (u - glow.x) * W;
        const dy = (v - glow.y) * H;
        const rr = glow.r * minDim;
        const fall = Math.exp(-((dx * dx + dy * dy) / (rr * rr)) * glow.k);
        if (fall < 0.002) continue;
        r += glow.color[0] * fall * glow.strength;
        g += glow.color[1] * fall * glow.strength;
        b += glow.color[2] * fall * glow.strength;
      }

      const exposure = scene.exposure ?? 1.18;
      r = 1 - Math.exp(-r * exposure);
      g = 1 - Math.exp(-g * exposure);
      b = 1 - Math.exp(-b * exposure);

      for (const acc of accents) {
        let a = accentAlpha(acc, x, y, u, v, W, H, minDim);
        if (a <= 0.001) continue;
        a *= acc.alpha;
        if (acc.mode === 'screen') {
          r = 1 - (1 - r) * (1 - acc.rgb[0] * a);
          g = 1 - (1 - g) * (1 - acc.rgb[1] * a);
          b = 1 - (1 - b) * (1 - acc.rgb[2] * a);
        } else {
          r = r * (1 - a) + acc.rgb[0] * a;
          g = g * (1 - a) + acc.rgb[1] * a;
          b = b * (1 - a) + acc.rgb[2] * a;
        }
      }

      for (const sp of spheres) {
        const R = sp.r * minDim;
        const dx = (x - sp.x * W) / R;
        const dy = (y - sp.y * H) / R;
        const rr = dx * dx + dy * dy;
        if (rr > 1) continue;
        const edge = 1 - sstep(1 - 2 / R, 1, Math.sqrt(rr));
        if (edge <= 0.002) continue;
        const nz = Math.sqrt(Math.max(0, 1 - rr));
        const diff = Math.max(0, dx * Lx + dy * Ly + nz * Lz);
        const fres = Math.pow(1 - nz, 3.2);
        const spec = Math.pow(Math.max(0, dx * Hx + dy * Hy + nz * Hz), 70);
        const mixT = 0.12 + 0.88 * Math.pow(diff, 0.85);
        let sr = sp.deep[0] * (1 - mixT) + sp.bright[0] * mixT;
        let sg = sp.deep[1] * (1 - mixT) + sp.bright[1] * mixT;
        let sb = sp.deep[2] * (1 - mixT) + sp.bright[2] * mixT;
        const ambient = 0.55 + 0.45 * nz;
        sr = sr * ambient + sp.rim[0] * fres * 0.5 + spec * 0.45;
        sg = sg * ambient + sp.rim[1] * fres * 0.5 + spec * 0.45;
        sb = sb * ambient + sp.rim[2] * fres * 0.5 + spec * 0.45;
        const a = edge;
        r = r * (1 - a) + clamp(sr) * a;
        g = g * (1 - a) + clamp(sg) * a;
        b = b * (1 - a) + clamp(sb) * a;
      }

      // Насыщенность и мягкий контраст: убирают «серость» аддитивного света.
      const sat = scene.saturation ?? 1.18;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = clamp(lum + (r - lum) * sat);
      g = clamp(lum + (g - lum) * sat);
      b = clamp(lum + (b - lum) * sat);
      const con = scene.contrast ?? 1.06;
      r = clamp(0.5 + (r - 0.5) * con);
      g = clamp(0.5 + (g - 0.5) * con);
      b = clamp(0.5 + (b - 0.5) * con);

      // Виньетка.
      const dxv = (u - 0.5) * 1.04;
      const dyv = (v - 0.5) * 1.04;
      const vig = 1 - 0.34 * smooth((dxv * dxv + dyv * dyv) * 1.25);
      r *= vig;
      g *= vig;
      b *= vig;

      const n = (grain() - 0.5) * 0.016;
      const o = (y * W + x) * 3;
      buffer[o] = Math.round(clamp(r + n) * 255);
      buffer[o + 1] = Math.round(clamp(g + n) * 255);
      buffer[o + 2] = Math.round(clamp(b + n) * 255);
    }
  }

  return encodePNG(W, H, buffer);
}

/* --------------------------------------------------------------- config --- */

const IMAGES = [
  {
    file: 'hero-aurora.png',
    title: 'Hero-обложка',
    width: 1600,
    height: 900,
    seed: 20260114,
    palette: ['#06081a', '#1a2c78', '#2de2e6', '#7b5cff', '#ff4ecd'],
    baseAngle: 0.72,
    glows: [
      { x: 0.16, y: 0.3, r: 0.55, color: '#7b5cff', strength: 0.5 },
      { x: 0.86, y: 0.58, r: 0.62, color: '#2de2e6', strength: 0.5 },
      { x: 0.6, y: 0.02, r: 0.4, color: '#ff4ecd', strength: 0.2 },
    ],
    accents: [
      {
        type: 'arc',
        cx: 0.86,
        cy: 0.58,
        r0: 0.06,
        step: 0.055,
        width: 1.2,
        alpha: 0.14,
        rmax: 0.72,
        a0: -1.1,
        a1: 1.5,
        color: '#7ce9ff',
      },
      { type: 'dots', cx: 0.2, cy: 0.74, mx: 0.2, my: 0.74, mr: 0.34, spacing: 16, radius: 0.9, alpha: 0.26, color: '#a9c8ff' },
      { type: 'lines', angle: 0.85, spacing: 64, width: 1, alpha: 0.045, color: '#6f8cff' },
    ],
  },
  {
    file: 'post-pulse.png',
    title: 'Пост в соцсетях',
    width: 1080,
    height: 1080,
    seed: 777,
    palette: ['#16040f', '#5a1236', '#ff6b6b', '#ffb347', '#ff2d78'],
    baseAngle: 1.2,
    glows: [
      { x: 0.58, y: 0.68, r: 0.5, color: '#ff2d78', strength: 0.5 },
      { x: 0.8, y: 0.18, r: 0.4, color: '#ffb347', strength: 0.24 },
      { x: 0.06, y: 0.12, r: 0.4, color: '#7b2ff7', strength: 0.16 },
    ],
    spheres: [
      { x: 0.58, y: 0.68, r: 0.31, deep: '#6d1233', bright: '#ff9a6b', rim: '#ffd9a8' },
    ],
    accents: [
      { type: 'dots', cx: 0.82, cy: 0.2, mx: 0.82, my: 0.2, mr: 0.45, spacing: 20, radius: 1.3, alpha: 0.3, color: '#ffd9a8' },
      { type: 'lines', angle: -0.6, spacing: 100, width: 1, alpha: 0.05, color: '#ff8fb3' },
    ],
  },
  {
    file: 'story-lime.png',
    title: 'Stories',
    width: 1080,
    height: 1920,
    seed: 31415,
    palette: ['#04120c', '#0d3a26', '#b6ff5c', '#21e6a8', '#eaffb0'],
    baseAngle: 1.35,
    glows: [
      { x: 0.5, y: 0.78, r: 0.5, color: '#b6ff5c', strength: 0.55 },
      { x: 0.2, y: 0.45, r: 0.45, color: '#21e6a8', strength: 0.36 },
      { x: 0.85, y: 0.9, r: 0.3, color: '#eaffb0', strength: 0.18 },
    ],
    accents: [
      { type: 'waves', y: 0.1, gap: 0.045, amp: 0.014, freq: 1.4, thickness: 1.1, alpha: 0.2, count: 6, color: '#9dffcf' },
      { type: 'dots', cx: 0.18, cy: 0.9, mx: 0.18, my: 0.9, mr: 0.4, spacing: 22, radius: 1.2, alpha: 0.18, color: '#d9ffb0' },
      { type: 'lines', angle: 1.5, spacing: 120, width: 1, alpha: 0.04, color: '#b6ff5c' },
    ],
  },
  {
    file: 'avatar-orb.png',
    title: 'Аватар',
    width: 512,
    height: 512,
    seed: 4242,
    palette: ['#08060f', '#231a52', '#b48cff', '#6ce5ff', '#ff9ae0'],
    baseAngle: 0.9,
    glows: [
      { x: 0.5, y: 0.5, r: 0.34, color: '#b48cff', strength: 0.42, k: 2.2 },
      { x: 0.5, y: 0.5, r: 0.24, color: '#6ce5ff', strength: 0.2, k: 2.4 },
      { x: 0.68, y: 0.72, r: 0.28, color: '#ff9ae0', strength: 0.18, k: 2.2 },
    ],
    spheres: [
      { x: 0.49, y: 0.48, r: 0.33, deep: '#2a1554', bright: '#c9a7ff', rim: '#8ff2ff' },
    ],
    accents: [
      { type: 'rings', cx: 0.5, cy: 0.5, r0: 0.4, step: 0.035, width: 1, alpha: 0.14, rmax: 0.72, color: '#8ceaff' },
      { type: 'dots', cx: 0.5, cy: 0.5, mx: 0.5, my: 0.5, mr: 0.5, spacing: 14, radius: 0.7, alpha: 0.12, color: '#e6c9ff' },
    ],
  },
  {
    file: 'og-night.png',
    title: 'OG-превью',
    width: 1200,
    height: 630,
    seed: 2024,
    palette: ['#050c1a', '#1b2d68', '#5ca8ff', '#ff8a5c', '#f2f5ff'],
    baseAngle: 0.5,
    glows: [
      { x: 0.22, y: 0.62, r: 0.5, color: '#5ca8ff', strength: 0.5 },
      { x: 0.82, y: 0.32, r: 0.38, color: '#ff8a5c', strength: 0.4 },
    ],
    accents: [
      { type: 'dots', cx: 0.82, cy: 0.32, mx: 0.82, my: 0.32, mr: 0.5, spacing: 18, radius: 1, alpha: 0.26, color: '#a9c8ff' },
      { type: 'lines', angle: -0.55, spacing: 78, width: 1, alpha: 0.05, color: '#7fa8ff' },
      { type: 'arc', cx: 0.82, cy: 0.32, r0: 0.16, step: 0.07, width: 1.2, alpha: 0.16, rmax: 0.62, color: '#ffb08a', a0: 0.4, a1: 2.6 },
    ],
  },
  {
    file: 'banner-sunset.png',
    title: 'Баннер',
    width: 1500,
    height: 500,
    seed: 555,
    palette: ['#160707', '#4a1218', '#ff9e4f', '#ff4e6a', '#ffd56b'],
    baseAngle: 1.05,
    glows: [
      { x: 0.24, y: 0.5, r: 0.42, color: '#ff9e4f', strength: 0.55 },
      { x: 0.88, y: 0.6, r: 0.45, color: '#ff4e6a', strength: 0.48 },
    ],
    spheres: [
      { x: 0.99, y: 0.5, r: 0.46, deep: '#4a0f12', bright: '#ffb066', rim: '#ffe0a8' },
    ],
    accents: [
      { type: 'lines', angle: 0, spacing: 34, width: 1, alpha: 0.07, color: '#ff9e4f', mask: { x: 0.86, y: 0.55, r: 0.55 } },
      { type: 'dots', cx: 0.24, cy: 0.5, mx: 0.24, my: 0.5, mr: 0.3, spacing: 20, radius: 1, alpha: 0.14, color: '#ffd9a8' },
    ],
  },
  {
    file: 'product-mint.png',
    title: 'Карточка товара',
    width: 800,
    height: 800,
    seed: 9090,
    palette: ['#04120f', '#0c3a30', '#7cf6d2', '#2bb3ff', '#f5fffc'],
    baseAngle: 0.65,
    glows: [
      { x: 0.5, y: 0.46, r: 0.34, color: '#7cf6d2', strength: 0.4 },
      { x: 0.82, y: 0.8, r: 0.35, color: '#2bb3ff', strength: 0.34 },
    ],
    spheres: [
      { x: 0.5, y: 0.47, r: 0.28, deep: '#0c5a4b', bright: '#a9ffe6', rim: '#f5fffc' },
    ],
    accents: [
      { type: 'rings', cx: 0.5, cy: 0.47, r0: 0.36, step: 0.045, width: 1, alpha: 0.18, rmax: 0.72, color: '#a8ffe8' },
      { type: 'dots', cx: 0.5, cy: 0.47, mx: 0.5, my: 0.47, mr: 0.56, spacing: 18, radius: 0.9, alpha: 0.1, color: '#d8fff5' },
    ],
  },
  {
    file: 'email-violet.png',
    title: 'Шапка письма',
    width: 1200,
    height: 400,
    seed: 123450,
    palette: ['#0a0718', '#2a1a5c', '#8e7cff', '#ff7ab6', '#ffe8a3'],
    baseAngle: 0.3,
    glows: [
      { x: 0.18, y: 0.6, r: 0.42, color: '#8e7cff', strength: 0.5 },
      { x: 0.78, y: 0.3, r: 0.36, color: '#ff7ab6', strength: 0.45 },
    ],
    accents: [
      { type: 'waves', y: 0.2, gap: 0.09, amp: 0.02, freq: 1.2, thickness: 1.1, alpha: 0.16, count: 4, color: '#c9b8ff' },
      { type: 'dots', cx: 0.78, cy: 0.3, mx: 0.78, my: 0.3, mr: 0.4, spacing: 16, radius: 0.9, alpha: 0.26, color: '#ffc6e2' },
      { type: 'rings', cx: 0.78, cy: 0.3, r0: 0.08, step: 0.06, width: 1, alpha: 0.11, rmax: 0.5, color: '#e0d6ff' },
    ],
  },
];

/* ----------------------------------------------------------------- main --- */

const manifest = [];

for (const scene of IMAGES) {
  const started = Date.now();
  const png = render(scene);
  fs.writeFileSync(path.join(OUT_DIR, scene.file), png);
  manifest.push({
    file: scene.file,
    title: scene.title,
    width: scene.width,
    height: scene.height,
    bytes: png.length,
    palette: scene.palette,
    seed: scene.seed,
  });
  console.log(
    `${scene.file.padEnd(20)} ${String(scene.width).padStart(4)}x${String(scene.height).padEnd(4)} ` +
      `${(png.length / 1024).toFixed(0).padStart(5)} KB  ${Date.now() - started} ms`
  );
}

{
  const cfg = { ...IMAGES[3], file: 'favicon.png', width: 64, height: 64 };
  const png = render({ ...cfg, glows: cfg.glows, accents: [] });
  fs.writeFileSync(path.join(OUT_DIR, cfg.file), png);
  manifest.push({ file: cfg.file, title: 'Favicon', width: 64, height: 64, bytes: png.length, palette: cfg.palette });
}

fs.writeFileSync(path.join(OUT_DIR, 'manifest.js'), `window.IMAGE_DATA = ${JSON.stringify(manifest, null, 2)};\n`);
console.log('\nmanifest.js записан, всего файлов:', manifest.length);
