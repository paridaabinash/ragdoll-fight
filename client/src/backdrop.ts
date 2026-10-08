import Phaser from 'phaser';
import { PX_PER_M, type ArenaPalette, type Logger } from '@ragdoll/shared';
import { VIEW } from './camera';
import { layerTile, TILE_W, type Shape } from './silhouettes';

/**
 * Building the backdrop should take well under this (ms); slower is logged as `slow_backdrop`. Measured: ~9 ms per
 * rebuild; the page's FIRST build also warms up canvas and GPU paths (35-75 ms on a busy machine), so it gets more.
 */
const SLOW_BUILD_MS = { first: 150, later: 40 } as const;
/** Backdrops built on this page so far (the first one is the cold start). */
let builds = 0;
/** The sky image is this many times the view, so it still covers the screen when the camera zooms out. */
const SKY_COVER = 1.8;
/** Sky texture size (px); scaled up, which also softens the glows. */
const SKY_TEX = { w: 320, h: 180 };
/** Extra px drawn around the layers so a zoomed-out camera never sees their ends. */
const MARGIN = 900;
const DEPTH = { sky: -100, layer: -90 } as const;

const css = (c: number, a = 1) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

/**
 * L1: the arena's moody backdrop, drawn from its palette: a sky gradient with soft glows (fixed on screen) and 2-3
 * parallax silhouette layers that move slower than the arena (farther = slower). Everything is drawn ONCE into
 * textures when the arena loads, so a frame only costs a few textured rectangles. Cosmetic only.
 */
export class Backdrop {
  private readonly objects: Phaser.GameObjects.GameObject[] = [];

  constructor(scene: Phaser.Scene, arena: { id: string; width: number; height: number; palette: ArenaPalette }, log: Logger) {
    const t0 = performance.now();
    const p = arena.palette;
    let shapes = 0;
    let cached = 0;
    scene.cameras.main.setBackgroundColor(css(p.sky.bottom));

    // sky: gradient + glows, fixed to the screen (scroll factor 0), centered and oversized for zoom-out
    const skyKey = `backdrop:${arena.id}:sky`;
    if (scene.textures.exists(skyKey)) cached++;
    else {
      const tex = scene.textures.createCanvas(skyKey, SKY_TEX.w, SKY_TEX.h)!;
      const ctx = tex.context;
      const grad = ctx.createLinearGradient(0, 0, 0, SKY_TEX.h);
      // the screen covers the middle 1/SKY_COVER of the image: put the palette's top/bottom at the screen's edges
      const edge = (1 - 1 / SKY_COVER) / 2;
      grad.addColorStop(edge, css(p.sky.top));
      grad.addColorStop(1 - edge, css(p.sky.bottom));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, SKY_TEX.w, SKY_TEX.h);
      for (const g of p.glow ?? []) {
        const x = (edge + g.x / SKY_COVER) * SKY_TEX.w;
        const y = (edge + g.y / SKY_COVER) * SKY_TEX.h;
        const r = (g.radius / SKY_COVER) * SKY_TEX.h;
        const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, css(g.color, g.alpha));
        rg.addColorStop(1, css(g.color, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      tex.refresh();
    }
    this.objects.push(
      scene.add
        .image(VIEW.width / 2, VIEW.height / 2, skyKey)
        .setDisplaySize(VIEW.width * SKY_COVER, VIEW.height * SKY_COVER)
        .setScrollFactor(0)
        .setDepth(DEPTH.sky),
    );

    // Where the camera usually is: following someone standing on the ground line.
    const horizon = p.horizon * PX_PER_M;
    const maxScrollY = Math.max(0, arena.height * PX_PER_M - VIEW.height);
    const usualScrollY = Math.max(0, Math.min(maxScrollY, horizon - PX_PER_M - VIEW.height / 2));
    p.layers.forEach((layer, i) => {
      const f = layer.depth;
      const tile = layerTile(layer, p.seed, i, PX_PER_M);
      shapes += tile.shapes.length;
      const key = `backdrop:${arena.id}:layer${i}`;
      if (scene.textures.exists(key)) cached++;
      else {
        const tex = scene.textures.createCanvas(key, TILE_W, tile.h)!;
        tex.context.fillStyle = css(layer.color);
        for (const dx of [-TILE_W, 0, TILE_W]) for (const s of tile.shapes) drawShape(tex.context, s, dx);
        tex.refresh();
      }
      // On screen a layer point sits at (y - scrollY * f): put its ground line where the arena's ground usually is.
      const ground = horizon - usualScrollY * (1 - f);
      const left = -MARGIN;
      const width = arena.width * PX_PER_M * f + VIEW.width + MARGIN * 2;
      if (layer.kind === 'chains') {
        // hanging from the top of the arena (the sprite is one tile tall: a taller one would repeat the tile downward)
        this.objects.push(scene.add.tileSprite(left, 0, width, tile.h, key).setOrigin(0).setScrollFactor(f).setDepth(DEPTH.layer + i));
        return;
      }
      this.objects.push(scene.add.tileSprite(left, ground - tile.h, width, tile.h, key).setOrigin(0).setScrollFactor(f).setDepth(DEPTH.layer + i));
      // solid colour below the ground line, so a pit or a zoomed-out view never shows the sky under a layer
      this.objects.push(scene.add.rectangle(left, ground - 1, width, arena.height * PX_PER_M + MARGIN * 2, layer.color).setOrigin(0).setScrollFactor(f).setDepth(DEPTH.layer + i));
    });

    const ms = Math.round((performance.now() - t0) * 10) / 10;
    const first = builds++ === 0;
    const limitMs = first ? SLOW_BUILD_MS.first : SLOW_BUILD_MS.later;
    log.info('backdrop_built', { arena: arena.id, layers: p.layers.length, shapes, glows: p.glow?.length ?? 0, cached, first, ms });
    if (ms > limitMs) log.warn('slow_backdrop', { arena: arena.id, ms, limitMs, first, layers: p.layers.length, shapes });
  }

  /** Hidden in the debug view (F2 shows physics outlines on a plain background). */
  setVisible(on: boolean): void {
    for (const o of this.objects) (o as unknown as Phaser.GameObjects.Components.Visible).setVisible(on);
  }

  destroy(): void {
    for (const o of this.objects) o.destroy();
    this.objects.length = 0;
  }
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, dx: number): void {
  if (s.t === 'rect') ctx.fillRect(s.x + dx, s.y, s.w, s.h);
  else if (s.t === 'circle') {
    ctx.beginPath();
    ctx.arc(s.x + dx, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(s.pts[0] + dx, s.pts[1]);
    for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i] + dx, s.pts[i + 1]);
    ctx.closePath();
    ctx.fill();
  }
}
