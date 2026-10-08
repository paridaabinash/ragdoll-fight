import Phaser from 'phaser';
import type { Vec2 } from '@ragdoll/shared';
import { VIEW } from './camera';

/** An enemy off the screen: where they are on the screen plane (px, may be outside it) and their color. */
export interface Offscreen {
  at: Vec2;
  color: number;
}

export interface HudFrame {
  lines: string[];
  /**
   * L3: a small ring at the mouse pointer (screen px) that fills up while the gun reloads (`ready` 0..1, 1 = ready);
   * `blocked`: can't shoot now (arms down, dead, laughing): drawn dim red. null: none (replays, before the mouse moved).
   */
  reticle: Reticle | null;
  offscreen: Offscreen[];
  /** Big panel (match results), or null. Sits on the left so a replay behind it stays visible. */
  banner: string[] | null;
  /** Big text at the top center (chaos round countdown), or null. */
  headline?: string | null;
}

export interface Reticle {
  at: Vec2;
  ready: number;
  color: number;
  blocked: boolean;
}

/** Reticle size (px): ring radius and line width. */
const RETICLE = { r: 11, width: 3 } as const;

/** A big callout banner (L1) waiting or showing at the top of the screen. */
export interface BannerCallout {
  text: string;
  fill: string;
  stroke: string;
  /** Font px. */
  size: number;
  /** Small line under it (who did it to whom). */
  sub: string;
  ms: number;
}

/** Banners sit under the chaos-round headline. */
const BANNER_Y = 118;

/** Markers sit this far inside the screen edge. */
const EDGE_INSET = 22;
const MARKER_SIZE = 11;

/**
 * Everything that stays put on the screen while the world camera scrolls and zooms: the text HUD, the kill feed,
 * the reload ring at the pointer, and arrows at the screen edge pointing at enemies you can't see.
 * Its own scene on top of the game scene, so its camera never moves.
 */
export class HudScene extends Phaser.Scene {
  private text!: Phaser.GameObjects.Text;
  private feedText!: Phaser.GameObjects.Text;
  private bannerText!: Phaser.GameObjects.Text;
  private headlineText!: Phaser.GameObjects.Text;
  private gfx!: Phaser.GameObjects.Graphics;
  private feedLines: { text: string; until: number }[] = [];
  private calloutText!: Phaser.GameObjects.Text;
  private calloutSub!: Phaser.GameObjects.Text;
  private bannerQueue: BannerCallout[] = [];
  private bannerNow: (BannerCallout & { at: number }) | null = null;
  private ready = false;

  constructor() {
    super('hud');
  }

  create(): void {
    this.gfx = this.add.graphics();
    // L1: light text on dark translucent panels, to match the dark arenas.
    const panel = { fontFamily: 'monospace', fontSize: '14px', color: '#e3e9ee', backgroundColor: '#05070bb0', padding: { x: 6, y: 4 } };
    this.text = this.add.text(8, 8, '', panel);
    this.feedText = this.add.text(VIEW.width - 8, 8, '', { ...panel, align: 'right' }).setOrigin(1, 0);
    this.bannerText = this.add
      .text(16, VIEW.height / 2 + 30, '', { fontFamily: 'monospace', fontSize: '17px', color: '#ffffff', align: 'left', backgroundColor: '#000000c0', padding: { x: 20, y: 14 } })
      .setOrigin(0, 0.5)
      .setVisible(false);
    this.headlineText = this.add
      .text(VIEW.width / 2, 70, '', { fontFamily: 'Impact, Arial Black, sans-serif', fontSize: '34px', color: '#ffea00', stroke: '#000000', strokeThickness: 7 })
      .setOrigin(0.5, 0)
      .setVisible(false);
    this.calloutText = this.add.text(VIEW.width / 2, BANNER_Y, '', { fontFamily: 'Impact, Arial Black, sans-serif', fontSize: '36px', strokeThickness: 7 }).setOrigin(0.5, 0).setVisible(false);
    this.calloutSub = this.add.text(VIEW.width / 2, BANNER_Y, '', { fontFamily: 'monospace', fontSize: '13px', color: '#e3e9ee', backgroundColor: '#05070bb0', padding: { x: 5, y: 2 } }).setOrigin(0.5, 0).setVisible(false);
    this.ready = true;
  }

  /**
   * Queues a big callout banner. Shown one at a time for `ms`; at most `maxQueued` wait behind the one showing
   * (the oldest waiting one is dropped). Returns how many wait now and how many were dropped.
   */
  banner(b: BannerCallout, maxQueued: number): { queued: number; dropped: number } {
    this.bannerQueue.push(b);
    const dropped = Math.max(0, this.bannerQueue.length - (this.bannerNow ? maxQueued : maxQueued + 1));
    this.bannerQueue.splice(0, dropped);
    return { queued: this.bannerQueue.length - (this.bannerNow ? 0 : 1), dropped };
  }

  private renderBanner(now: number): void {
    if (this.bannerNow && now - this.bannerNow.at >= this.bannerNow.ms) this.bannerNow = null;
    if (!this.bannerNow && this.bannerQueue.length) {
      this.bannerNow = { ...this.bannerQueue.shift()!, at: now };
      const b = this.bannerNow;
      this.calloutText.setText(b.text).setStyle({ fontSize: `${b.size}px`, color: b.fill, stroke: b.stroke });
      this.calloutSub.setText(b.sub);
    }
    const b = this.bannerNow;
    this.calloutText.setVisible(!!b);
    this.calloutSub.setVisible(!!b);
    if (!b) return;
    const age = now - b.at;
    // pop in, hold, fade out
    const pop = Math.min(1, age / 120);
    const alpha = Math.min(1, (b.ms - age) / 250);
    this.calloutText.setScale(0.5 + 0.5 * (pop < 1 ? Phaser.Math.Easing.Back.Out(pop) : 1)).setAlpha(alpha);
    this.calloutSub.setPosition(VIEW.width / 2, BANNER_Y + this.calloutText.height + 2).setAlpha(alpha);
  }

  /** A kill-feed line, top right, shown for a few seconds. */
  feed(line: string, ms = 4000): void {
    this.feedLines.push({ text: line, until: performance.now() + ms });
  }

  get feedNow(): string[] {
    return this.feedLines.map((l) => l.text);
  }

  render(frame: HudFrame): void {
    if (!this.ready) return;
    const now = performance.now();
    this.feedLines = this.feedLines.filter((l) => l.until > now).slice(-4);
    this.feedText.setText(this.feedNow);
    this.text.setText(frame.lines);
    // L6: a long help line reaches the top right corner: the feed then sits under the text block instead of on it
    const feedLeft = this.feedText.x - this.feedText.width;
    const clash = this.feedLines.length > 0 && this.text.x + this.text.width + 12 > feedLeft;
    this.feedText.setY(clash ? this.text.y + this.text.height + 6 : 8);
    this.bannerText.setVisible(!!frame.banner).setText(frame.banner ?? []);
    this.headlineText.setVisible(!!frame.headline).setText(frame.headline ?? '');
    this.renderBanner(now);
    const g = this.gfx;
    g.clear();
    if (frame.reticle) this.drawReticle(g, frame.reticle);
    for (const o of frame.offscreen) this.edgeMarker(g, o);
  }

  /** The reload ring: a faint full circle, the done part in your colour (white tick marks when ready). */
  private drawReticle(g: Phaser.GameObjects.Graphics, r: Reticle): void {
    const { x, y } = r.at;
    g.lineStyle(RETICLE.width + 2, 0x000000, 0.45).strokeCircle(x, y, RETICLE.r);
    if (r.blocked) {
      g.lineStyle(RETICLE.width, 0xef5350, 0.6).strokeCircle(x, y, RETICLE.r);
      return;
    }
    const ready = r.ready >= 1;
    g.lineStyle(RETICLE.width, ready ? 0xffffff : r.color, ready ? 0.9 : 1);
    g.beginPath();
    g.arc(x, y, RETICLE.r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.001, Math.min(1, r.ready)), false);
    g.strokePath();
    if (ready) for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) g.lineBetween(x + Math.cos(a) * (RETICLE.r + 2), y + Math.sin(a) * (RETICLE.r + 2), x + Math.cos(a) * (RETICLE.r + 6), y + Math.sin(a) * (RETICLE.r + 6));
  }

  /** A triangle at the screen edge, on the line from the screen center toward the enemy, pointing at them. */
  private edgeMarker(g: Phaser.GameObjects.Graphics, o: Offscreen): void {
    const cx = VIEW.width / 2;
    const cy = VIEW.height / 2;
    const dx = o.at.x - cx;
    const dy = o.at.y - cy;
    if (dx === 0 && dy === 0) return;
    const halfW = cx - EDGE_INSET;
    const halfH = cy - EDGE_INSET;
    const t = Math.min(halfW / Math.abs(dx || 1e-9), halfH / Math.abs(dy || 1e-9));
    const x = cx + dx * t;
    const y = cy + dy * t;
    const a = Math.atan2(dy, dx);
    const pt = (r: number, ang: number) => ({ x: x + Math.cos(a + ang) * r, y: y + Math.sin(a + ang) * r });
    const tip = pt(MARKER_SIZE, 0);
    const left = pt(MARKER_SIZE * 0.8, 2.4);
    const right = pt(MARKER_SIZE * 0.8, -2.4);
    g.fillStyle(0x000000, 0.55);
    g.fillCircle(x, y, MARKER_SIZE + 3);
    g.fillStyle(o.color, 1);
    g.fillTriangle(tip.x, tip.y, left.x, left.y, right.x, right.y);
  }
}

/** Starts the HUD on top of `scene` (once) and returns it. */
export function launchHud(scene: Phaser.Scene): HudScene {
  const existing = scene.scene.get('hud') as HudScene | null;
  if (existing) return existing;
  return scene.scene.add('hud', new HudScene(), true) as HudScene;
}
