import Phaser from 'phaser';
import type { Vec2 } from '@ragdoll/shared';
import { VIEW } from './camera';

/** L7: one row of the players panel (everyone's colour, name and score; you marked). */
export interface LegendRow {
  name: string;
  color: number;
  score: number;
  you: boolean;
  crown: boolean;
  alive: boolean;
}

/** An enemy off the screen: where they are on the screen plane (px, may be outside it) and their color. */
export interface Offscreen {
  at: Vec2;
  color: number;
  /** L7: they lost a leg: the marker flashes with a small leg sign. */
  stump?: boolean;
}

export interface HudFrame {
  lines: string[];
  offscreen: Offscreen[];
  /** Big panel (match results), or null. Sits on the left. */
  banner: string[] | null;
  /** Big text at the top center (chaos round countdown), or null. */
  headline?: string | null;
  /** L7: the players panel (top left); the text lines then sit under it. */
  legend?: LegendRow[];
  /** L7: one small quiet line at the top center (the match clock), or null. */
  top?: string | null;
  /** L7: one small quiet line at the bottom left (room, ping, controls help), or null. */
  info?: string | null;
}


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

/** L7 players panel (px): position, width, row height, padding, font size. */
const LEGEND = { x: 8, y: 8, width: 230, row: 20, pad: 6, font: 13 } as const;

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
  private topText!: Phaser.GameObjects.Text;
  private infoText!: Phaser.GameObjects.Text;
  /** L7 players panel: one name + one score text per row (reused). */
  private legendRows: { name: Phaser.GameObjects.Text; score: Phaser.GameObjects.Text }[] = [];
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
    this.topText = this.add.text(VIEW.width / 2, 8, '', { fontFamily: 'monospace', fontSize: '14px', color: '#e3e9eebb' }).setOrigin(0.5, 0);
    this.infoText = this.add.text(8, VIEW.height - 6, '', { fontFamily: 'monospace', fontSize: '12px', color: '#e3e9ee88' }).setOrigin(0, 1);
    this.ready = true;
  }

  /** L7: the players panel, top left: a dot in each player's colour, the name, the score; you in bold white. Returns its bottom (px). */
  private drawLegend(g: Phaser.GameObjects.Graphics, rows: LegendRow[]): number {
    const L = LEGEND;
    while (this.legendRows.length < rows.length) {
      const style = { fontFamily: 'monospace', fontSize: `${L.font}px`, color: '#e3e9ee' };
      this.legendRows.push({ name: this.add.text(0, 0, '', style).setOrigin(0, 0.5), score: this.add.text(0, 0, '', style).setOrigin(1, 0.5) });
    }
    this.legendRows.forEach((r, i) => {
      r.name.setVisible(i < rows.length);
      r.score.setVisible(i < rows.length);
    });
    if (!rows.length) return 0;
    const h = L.pad * 2 + rows.length * L.row;
    g.fillStyle(0x05070b, 0.55).fillRoundedRect(L.x, L.y, L.width, h, 6);
    rows.forEach((row, i) => {
      const y = L.y + L.pad + L.row * (i + 0.5);
      g.fillStyle(row.color, row.alive ? 1 : 0.35).fillCircle(L.x + L.pad + 5, y, 5);
      const t = this.legendRows[i];
      const color = row.you ? '#ffffff' : row.alive ? '#c9d1d9' : '#6b7480';
      t.name.setText(`${row.crown ? '♛ ' : ''}${row.name}${row.you ? '  (you)' : ''}`).setPosition(L.x + L.pad + 16, y).setColor(color).setFontStyle(row.you ? 'bold' : '');
      t.score.setText(String(row.score)).setPosition(L.x + L.width - L.pad, y).setColor(color).setFontStyle(row.you ? 'bold' : '');
    });
    return L.y + h;
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
    const g = this.gfx;
    g.clear();
    const legendBottom = this.drawLegend(g, frame.legend ?? []);
    this.text.setText(frame.lines).setVisible(frame.lines.length > 0).setY(legendBottom ? legendBottom + 6 : 8);
    this.topText.setVisible(!!frame.top).setText(frame.top ?? '');
    this.infoText.setVisible(!!frame.info).setText(frame.info ?? '');
    // L6: a long help line reaches the top right corner: the feed then sits under the text block instead of on it
    const feedLeft = this.feedText.x - this.feedText.width;
    const clash = this.feedLines.length > 0 && this.text.visible && this.text.x + this.text.width + 12 > feedLeft;
    // (below the quiet match line at the top center, which a long feed line would reach)
    this.feedText.setY(clash ? this.text.y + this.text.height + 6 : 30);
    this.bannerText.setVisible(!!frame.banner).setText(frame.banner ?? []);
    this.headlineText.setVisible(!!frame.headline).setText(frame.headline ?? '');
    this.renderBanner(now);
    for (const o of frame.offscreen) this.edgeMarker(g, o);
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
    if (o.stump && Math.floor(performance.now() / 250) % 2 === 0) {
      // a small leg: thigh + shin bent at the knee, beside the marker (flashing)
      const lx = x - Math.cos(a) * (MARKER_SIZE + 12);
      const ly = y - Math.sin(a) * (MARKER_SIZE + 12);
      g.lineStyle(3, 0xffd1dc, 1).beginPath().moveTo(lx - 2, ly - 7).lineTo(lx + 2, ly).lineTo(lx - 1, ly + 7).strokePath();
    }
  }
}

/** Starts the HUD on top of `scene` (once) and returns it. */
export function launchHud(scene: Phaser.Scene): HudScene {
  const existing = scene.scene.get('hud') as HudScene | null;
  if (existing) return existing;
  return scene.scene.add('hud', new HudScene(), true) as HudScene;
}
