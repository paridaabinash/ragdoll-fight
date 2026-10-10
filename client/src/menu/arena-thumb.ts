import { arenaById, arenaInfo, arenaLayout, type ArenaDef, type ArenaPalette } from '@ragdoll/shared';
import { SURFACE_LOOK } from '../skin';

const css = (c: number, a = 1) => `rgba(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}, ${a})`;
const cache = new Map<string, string>();

/**
 * M4: a small picture of an arena, drawn from its data (sky, floors and their bright edges, pits, crates, hazards,
 * aurora), so every arena gets a card for free and the card always matches the arena. Cached as an image URL.
 */
export function arenaThumb(id: string, width = 320, height = 180): string {
  const key = `${id}@${width}x${height}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const def = arenaById(id);
  const url = def ? draw(def, width, height) : '';
  cache.set(key, url);
  return url;
}

function draw(def: ArenaDef, width: number, height: number): string {
  const layout = arenaLayout(def, 'full');
  const pal = arenaInfo(layout).palette;
  const canvas = document.createElement('canvas');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const g = canvas.getContext('2d')!;
  g.scale(ratio, ratio);
  // the whole arena fits, bottom-aligned (floors matter more than open sky)
  const s = Math.min(width / layout.width, height / layout.height);
  const ox = (width - layout.width * s) / 2;
  const oy = height - layout.height * s;
  paintSky(g, pal, width, height);
  const X = (m: number) => ox + m * s;
  const Y = (m: number) => oy + m * s;
  for (const p of layout.pits) {
    g.fillStyle = 'rgba(255, 60, 60, 0.25)';
    g.fillRect(X(p.x), Y(p.y), p.w * s, Math.max(2, p.h * s));
  }
  const edge = Math.max(1.5, s * 0.15);
  for (const b of layout.solids) {
    const look = b.surface ? SURFACE_LOOK[b.surface] : null;
    g.fillStyle = css(look?.fill ?? pal.terrain);
    g.fillRect(X(b.x), Y(b.y), b.w * s, b.h * s);
    g.fillStyle = css(look?.edge ?? pal.accent);
    g.fillRect(X(b.x), Y(b.y), b.w * s, edge);
  }
  for (const c of layout.crates) {
    g.fillStyle = '#6d4c41';
    g.fillRect(X(c.x - c.size / 2), Y(c.y - c.size / 2), c.size * s, c.size * s);
  }
  g.lineWidth = Math.max(1, s * 0.12);
  for (const h of layout.hazards) {
    g.strokeStyle = g.fillStyle = css(pal.accent, 0.9);
    if (h.kind === 'trampoline') g.fillRect(X(h.x), Y(h.y) - edge, h.w * s, edge * 1.5);
    else if (h.kind === 'conveyor') g.fillRect(X(h.x), Y(h.y) - edge, h.w * s, edge);
    else if (h.kind === 'seesaw') {
      g.beginPath();
      g.moveTo(X(h.x - h.length / 2), Y(h.y));
      g.lineTo(X(h.x + h.length / 2), Y(h.y));
      g.stroke();
    } else if (h.kind === 'wrecking_ball') {
      g.beginPath();
      g.moveTo(X(h.x), Y(h.y));
      g.lineTo(X(h.x), Y(h.y + h.length));
      g.stroke();
      g.beginPath();
      g.arc(X(h.x), Y(h.y + h.length), h.radius * s, 0, Math.PI * 2);
      g.fillStyle = '#90a4ae';
      g.fill();
    } else if (h.kind === 'wind') {
      g.fillStyle = 'rgba(255, 255, 255, 0.07)';
      g.fillRect(X(h.x), Y(h.y), h.w * s, h.h * s);
    }
  }
  return canvas.toDataURL('image/png');
}

/** The arena's sky (gradient, glows, aurora curtains) into a 2D canvas: thumbnails and the cover art (M5). */
export function paintSky(g: CanvasRenderingContext2D, pal: ArenaPalette, width: number, height: number): void {
  const sky = g.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, css(pal.sky.top));
  sky.addColorStop(1, css(pal.sky.bottom));
  g.fillStyle = sky;
  g.fillRect(0, 0, width, height);
  for (const glow of pal.glow ?? []) {
    const r = glow.radius * width;
    const grad = g.createRadialGradient(glow.x * width, glow.y * height, 0, glow.x * width, glow.y * height, r);
    grad.addColorStop(0, css(glow.color, glow.alpha));
    grad.addColorStop(1, css(glow.color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, width, height);
  }
  for (const a of pal.aurora ?? []) {
    const y = a.y * height;
    const grad = g.createLinearGradient(0, y - a.height * height, 0, y);
    grad.addColorStop(0, css(a.top, 0));
    grad.addColorStop(1, css(a.color, a.alpha));
    g.fillStyle = grad;
    for (let x = 0; x < width; x += 3) {
      const wave = Math.sin((x / width) * Math.PI * 3 + a.phase) * a.fold * height;
      g.fillRect(x, y - a.height * height + wave, 2, a.height * height);
    }
  }
}
