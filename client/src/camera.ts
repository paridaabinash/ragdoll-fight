import Phaser from 'phaser';
import { PX_PER_M, r2, type ArenaBounds, type Logger, type Vec2 } from '@ragdoll/shared';

/** The game canvas: 1280 x 720 px = 32 x 18 m at zoom 1. Arenas bigger than this scroll. */
export const VIEW = { width: 1280, height: 720 } as const;

export const CAMERA = {
  /** L3: how much of the arena's width you see (m) *(start)*. Never more than the arena itself (no space outside it). */
  viewWidth: 36,
  /**
   * L7: the view leans toward your aim point by this share of its distance from you *(start: half, so up to 2.5 m)*,
   * so looking ahead is something you choose. (L3 leaned toward the screen pointer, a third of the way to the edge.)
   */
  lean: 0.5,
  /** Smoothing time (s): how quickly the view catches up with you / the lean. */
  followTime: 0.12,
} as const;

/**
 * Follows your body through an arena bigger than the screen, at a fixed zoom (about CAMERA.viewWidth m wide), leaning
 * toward your aim point (L7; there's no zoom-out: the gun has no draw).
 * Cosmetic only (the client draws; the server decides), so it never touches the game world.
 */
export class FollowCamera {
  private center: Vec2;
  private readonly zoom: number;
  private readonly worldPx: { w: number; h: number };

  constructor(
    private readonly cam: Phaser.Cameras.Scene2D.Camera,
    bounds: ArenaBounds,
    log: Logger,
  ) {
    this.worldPx = { w: bounds.width * PX_PER_M, h: bounds.height * PX_PER_M };
    // Zooming out further than the arena would show space outside it.
    const minZoom = Math.min(1, Math.max(VIEW.width / this.worldPx.w, VIEW.height / this.worldPx.h));
    this.zoom = Math.max(VIEW.width / (CAMERA.viewWidth * PX_PER_M), minZoom);
    this.center = { x: this.worldPx.w / 2, y: this.worldPx.h / 2 };
    const scrolls = this.worldPx.w > VIEW.width / this.zoom + 1 || this.worldPx.h > VIEW.height / this.zoom + 1;
    log.info('camera_setup', {
      arenaW: bounds.width,
      arenaH: bounds.height,
      mode: scrolls ? 'follow' : 'fixed',
      zoom: r2(this.zoom),
      viewW: r2(VIEW.width / this.zoom / PX_PER_M),
      viewH: r2(VIEW.height / this.zoom / PX_PER_M),
      lean: r2(CAMERA.lean),
    });
    this.apply();
  }

  /**
   * `target`: your body center (m), or null to stay put (e.g. not spawned yet). `aimOffset`: your aim point's offset
   * from you (m), or null for no lean (dead, before the mouse moved).
   */
  update(target: Vec2 | null, aimOffset: Vec2 | null, deltaMs: number): void {
    const dt = Math.min(deltaMs, 100) / 1000;
    if (target) {
      // the aim point moves with you, so moving the view never feeds back into the lean
      const lean = aimOffset ? { x: aimOffset.x * CAMERA.lean, y: aimOffset.y * CAMERA.lean } : { x: 0, y: 0 };
      const want = { x: (target.x + lean.x) * PX_PER_M, y: (target.y + lean.y) * PX_PER_M };
      const k = 1 - Math.exp(-dt / CAMERA.followTime);
      this.center = { x: this.center.x + (want.x - this.center.x) * k, y: this.center.y + (want.y - this.center.y) * k };
    }
    this.apply();
  }

  /** Jump straight to a spot (first frame, respawn), without the smooth slide. */
  snapTo(target: Vec2): void {
    this.center = { x: target.x * PX_PER_M, y: target.y * PX_PER_M };
    this.apply();
  }

  /** The visible part of the world, in pixels. */
  viewRect(): Phaser.Geom.Rectangle {
    const w = VIEW.width / this.zoom;
    const h = VIEW.height / this.zoom;
    return new Phaser.Geom.Rectangle(this.center.x - w / 2, this.center.y - h / 2, w, h);
  }

  /** A world point (m) on the screen (px). */
  toScreen(p: Vec2): Vec2 {
    const v = this.viewRect();
    return { x: (p.x * PX_PER_M - v.x) * this.zoom, y: (p.y * PX_PER_M - v.y) * this.zoom };
  }

  /** Of these world points (m), the ones outside the view, on the screen plane (for edge markers). */
  offscreen<T extends { at: Vec2 }>(list: T[]): T[] {
    const v = this.viewRect();
    return list
      .filter((o) => !v.contains(o.at.x * PX_PER_M, o.at.y * PX_PER_M))
      .map((o) => ({ ...o, at: this.toScreen(o.at) }));
  }

  /** Keeps the view inside the arena (centered when the arena is smaller than the view). */
  private apply(): void {
    const halfW = VIEW.width / this.zoom / 2;
    const halfH = VIEW.height / this.zoom / 2;
    const clamp = (v: number, half: number, size: number) => (size <= half * 2 ? size / 2 : Math.max(half, Math.min(size - half, v)));
    this.center = { x: clamp(this.center.x, halfW, this.worldPx.w), y: clamp(this.center.y, halfH, this.worldPx.h) };
    this.cam.setZoom(this.zoom);
    this.cam.centerOn(this.center.x, this.center.y);
  }
}
