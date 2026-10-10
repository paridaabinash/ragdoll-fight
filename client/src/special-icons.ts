import type Phaser from 'phaser';
import type { SpecialKind, Vec2 } from '@ragdoll/shared';
import { px } from './draw';

/**
 * L7: a big, detailed picture of each special round, so everyone sees at a glance what a gun is loaded with (a boxing
 * glove sticking out of the barrel, a balloon tied to it, ...), and the same picture flies as the bullet's head.
 * Drawn in a local frame: x forward along `angle` (from `at`), y across it, both in units of `size` (m). The balloon
 * and the bomb's spark keep "up" as world up.
 */
export function drawSpecialIcon(g: Phaser.GameObjects.Graphics, kind: SpecialKind, at: Vec2, angle: number, size: number, alpha = 1, nowMs = 0): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // (aiming left: mirror "across", so the picture is never upside down)
  const side = c < 0 ? -1 : 1;
  const P = (x: number, y: number) => ({ x: px(at.x + (x * c - y * side * s) * size), y: px(at.y + (x * s + y * side * c) * size) });
  const W = (x: number, y: number) => ({ x: px(at.x + x * size), y: px(at.y + y * size) }); // world-aligned
  const r = (v: number) => px(v * size);
  const ellipse = (cx: number, cy: number, rx: number, ry: number, rot = 0, world = false) => {
    const pts: Vec2[] = [];
    for (let i = 0; i < 20; i++) {
      const t = (i / 20) * Math.PI * 2;
      const x = cx + Math.cos(t) * rx * Math.cos(rot) - Math.sin(t) * ry * Math.sin(rot);
      const y = cy + Math.cos(t) * rx * Math.sin(rot) + Math.sin(t) * ry * Math.cos(rot);
      pts.push(world ? W(x, y) : P(x, y));
    }
    return pts;
  };
  const fill = (pts: Vec2[], color: number, a = 1) => g.fillStyle(color, a * alpha).fillPoints(pts as Phaser.Math.Vector2[], true);
  const line = (pts: Vec2[], color: number, width: number, a = 1) => {
    g.lineStyle(width, color, a * alpha).beginPath().moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
    g.strokePath();
  };
  const outline = 0x1a1a1a;

  switch (kind) {
    case 'glove': {
      // white cuff, then the red mitt (darker underside), the thumb, laces, a shine
      fill([P(0, -0.2), P(0.24, -0.23), P(0.24, 0.23), P(0, 0.2)], 0xf5f5f5);
      line([P(0.04, -0.2), P(0.04, 0.2)], 0xbdbdbd, Math.max(1, r(0.03)));
      fill(ellipse(0.58, 0, 0.38, 0.32), outline);
      fill(ellipse(0.58, 0, 0.35, 0.29), 0xe53935);
      fill(ellipse(0.6, 0.1, 0.3, 0.17), 0xb71c1c);
      fill(ellipse(0.42, -0.3, 0.16, 0.1, -0.5), outline);
      fill(ellipse(0.42, -0.3, 0.14, 0.08, -0.5), 0xe53935);
      for (const y of [-0.1, 0, 0.1]) line([P(0.27, y - 0.04), P(0.33, y + 0.04)], 0xffffff, Math.max(1, r(0.025)));
      fill(ellipse(0.7, -0.14, 0.09, 0.05, -0.3), 0xffffff, 0.55);
      break;
    }
    case 'balloon': {
      // tied to the barrel's tip, floating up (world up), a little sway
      const sway = Math.sin(nowMs / 400) * 0.06;
      const top = { x: 0.1 + sway, y: -0.85 };
      const knot = { x: top.x, y: top.y + 0.42 };
      line([W(0, 0), W(0.04 + sway / 2, -0.25), W(knot.x, knot.y)], 0x37474f, Math.max(1, r(0.025)));
      fill([W(knot.x - 0.05, knot.y + 0.04), W(knot.x + 0.05, knot.y + 0.04), W(knot.x, knot.y - 0.04)], 0xc2185b);
      fill(ellipse(top.x, top.y, 0.32, 0.4, 0, true), outline);
      fill(ellipse(top.x, top.y, 0.29, 0.37, 0, true), 0xff4fa3);
      fill(ellipse(top.x + 0.06, top.y + 0.08, 0.2, 0.26, 0, true), 0xe91e63, 0.5);
      fill(ellipse(top.x - 0.1, top.y - 0.14, 0.06, 0.1, -0.4, true), 0xffffff, 0.7);
      break;
    }
    case 'oil': {
      // a glossy dark glob of oil hanging off the barrel, dripping, with a rainbow sheen
      // (a bright green rim: dark oil alone vanished against the night arenas)
      fill(ellipse(0.32, 0.02, 0.32, 0.26), 0x9ccc65);
      fill(ellipse(0.32, 0.02, 0.28, 0.22), 0x1b2a1e);
      fill([P(0.16, 0.16), P(0.24, 0.17), P(0.2, 0.42)], 0x1b2a1e);
      fill(ellipse(0.2, 0.44, 0.05, 0.06), 0x1b2a1e);
      fill([P(0.4, 0.18), P(0.46, 0.17), P(0.43, 0.32)], 0x1b2a1e);
      line([P(0.15, -0.08), P(0.3, -0.13), P(0.46, -0.1)], 0x66bb6a, Math.max(1, r(0.03)), 0.8);
      line([P(0.18, -0.03), P(0.32, -0.08), P(0.44, -0.04)], 0x7c4dff, Math.max(1, r(0.025)), 0.6);
      fill(ellipse(0.4, -0.1, 0.06, 0.035), 0xffffff, 0.6);
      break;
    }
    case 'plunger': {
      // a wooden handle out of the barrel and the red rubber cup on its end (open side forward)
      fill([P(0, -0.05), P(0.55, -0.05), P(0.55, 0.05), P(0, 0.05)], 0x8d6e63);
      line([P(0.05, 0), P(0.5, 0)], 0x6d4c41, Math.max(1, r(0.02)));
      const cup: Vec2[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = -Math.PI / 2 + (i / 12) * Math.PI;
        cup.push(P(0.55 + Math.cos(t) * 0.22, Math.sin(t) * 0.3));
      }
      fill([...cup, P(0.55, 0.3)], outline);
      const inner: Vec2[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = -Math.PI / 2 + (i / 12) * Math.PI;
        inner.push(P(0.55 + Math.cos(t) * 0.19, Math.sin(t) * 0.27));
      }
      fill(inner, 0xd32f2f);
      line([P(0.77, -0.28), P(0.77, 0.28)], 0x8e0000, Math.max(1, r(0.05)));
      fill(ellipse(0.62, -0.12, 0.05, 0.08), 0xffffff, 0.4);
      break;
    }
    case 'bomb': {
      // a round black bomb on the barrel, a fuse with a blinking spark (world up)
      const ball = { x: 0.38, y: 0 };
      // (a light rim: a black bomb alone vanished against the night arenas)
      fill(ellipse(ball.x, ball.y, 0.31, 0.31), 0xb0bec5);
      fill(ellipse(ball.x, ball.y, 0.27, 0.27), 0x263238);
      fill(ellipse(ball.x - 0.08, ball.y - 0.1, 0.08, 0.06, -0.6), 0xffffff, 0.45);
      fill([P(0.3, -0.27), P(0.46, -0.27), P(0.46, -0.34), P(0.3, -0.34)], 0x455a64);
      const fuseStart = P(0.38, -0.34);
      const lit = Math.floor(nowMs / 120) % 2 === 0;
      const tip = { x: fuseStart.x + r(0.1), y: fuseStart.y - r(0.16) };
      g.lineStyle(Math.max(1, r(0.035)), 0x8d6e63, alpha).lineBetween(fuseStart.x, fuseStart.y, tip.x, tip.y);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + (lit ? 0.3 : 0);
        g.lineStyle(Math.max(1, r(0.025)), lit ? 0xffea00 : 0xff6d00, alpha).lineBetween(tip.x, tip.y, tip.x + Math.cos(a) * r(0.09), tip.y + Math.sin(a) * r(0.09));
      }
      break;
    }
    case 'banana': {
      // a fat yellow banana curving out of the barrel, brown tips
      const outer: Vec2[] = [];
      const inner: Vec2[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const x = t * 0.75;
        const bend = -0.16 * Math.sin(t * Math.PI);
        const thick = 0.17 * Math.sin(t * Math.PI) + 0.04;
        outer.push(P(x, bend - thick));
        inner.push(P(x, bend + thick));
      }
      fill([...outer, ...inner.reverse()], outline);
      const o2 = outer.map((p, i) => ({ x: p.x, y: p.y + (i > 0 && i < 12 ? 1.5 : 0) }));
      fill([...o2, ...inner.map((p, i) => ({ x: p.x, y: p.y - (i > 0 && i < 12 ? 1.5 : 0) }))], 0xffd600);
      line([P(0.12, -0.1), P(0.38, -0.2), P(0.63, -0.1)], 0xfff59d, Math.max(1, r(0.03)), 0.8);
      fill(ellipse(0.0, 0.0, 0.05, 0.05), 0x5d4037);
      fill(ellipse(0.75, 0.0, 0.045, 0.045), 0x5d4037);
      break;
    }
    case 'swap': {
      // two arrows chasing each other round (purple and cyan): you trade places
      const ring = (from: number, to: number, color: number) => {
        const pts: Vec2[] = [];
        for (let i = 0; i <= 10; i++) {
          const t = from + ((to - from) * i) / 10;
          pts.push(P(0.4 + Math.cos(t) * 0.28, Math.sin(t) * 0.28));
        }
        line(pts, outline, Math.max(2, r(0.13)));
        line(pts, color, Math.max(1, r(0.08)));
        const end = to;
        const tip = P(0.4 + Math.cos(end) * 0.28, Math.sin(end) * 0.28);
        const dir = end + Math.PI / 2;
        const a = P(0.4 + Math.cos(end) * 0.16, Math.sin(end) * 0.16);
        const b = P(0.4 + Math.cos(end) * 0.4, Math.sin(end) * 0.4);
        const f = P(0.4 + Math.cos(end) * 0.28 + Math.cos(dir) * 0.14, Math.sin(end) * 0.28 + Math.sin(dir) * 0.14);
        fill([a, b, f], color);
        void tip;
      };
      ring(0.2, Math.PI - 0.4, 0x7c4dff);
      ring(Math.PI + 0.2, 2 * Math.PI - 0.4, 0x00e5ff);
      break;
    }
    case 'feather': {
      // a white feather: a soft vane around a quill, a few barbs, a slight curve
      const vane: Vec2[] = [];
      for (let i = 0; i <= 16; i++) {
        const t = (i / 16) * Math.PI * 2;
        vane.push(P(0.45 + Math.cos(t) * 0.36, Math.sin(t) * 0.13 - 0.05 * Math.cos(t)));
      }
      fill(vane, 0x9e9e9e);
      fill(vane.map((p) => ({ x: p.x, y: p.y })), 0xfafafa, 0.95);
      line([P(0, 0), P(0.4, -0.02), P(0.84, -0.06)], 0xbdbdbd, Math.max(1, r(0.03)));
      for (const x of [0.25, 0.38, 0.5, 0.62]) {
        line([P(x, -0.02), P(x + 0.08, -0.12)], 0xcfd8dc, Math.max(1, r(0.015)));
        line([P(x, -0.02), P(x + 0.08, 0.08)], 0xcfd8dc, Math.max(1, r(0.015)));
      }
      break;
    }
  }
}
