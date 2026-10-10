import Phaser from 'phaser';
import { AIM_POINT, GUN, PX_PER_M, type GameEvent, type Rect, type Vec2 } from '@ragdoll/shared';

/** Drawing helpers shared by the offline scene and the online scene, so both look exactly the same. */

export const px = (m: number): number => m * PX_PER_M;

/** fixed = grey, dynamic = green (dimmed while asleep), you = blue, other players = orange */
export const COLORS = {
  fixed: 0x90a4ae,
  dynamic: 0x66bb6a,
  player: 0xffa726,
  you: 0x42a5f5,
  appleRed: 0xef5350,
  appleGold: 0xffca28,
} as const;

/** L3: how many ticks of the path the player sees (0.5 s): exact, but you judge the drop after that. */
export const PREVIEW_DOTS = GUN.previewTicks;
const BAR = { width: 50, height: 5, gap: 2, above: 0.45 }; // above: meters over the head

export interface OutlineLike {
  points: Vec2[];
  circle?: { center: Vec2; radius: number };
}

export function colorFor(label: string, kind: 'fixed' | 'dynamic' | 'player', isMe: boolean): number {
  if (label.startsWith('apple:red')) return COLORS.appleRed;
  if (label.startsWith('apple:gold')) return COLORS.appleGold;
  if (kind === 'player') return isMe ? COLORS.you : COLORS.player;
  return COLORS[kind];
}

/** No art yet: every collider is drawn as its physics outline (what you see is what collides). */
export function strokeOutline(g: Phaser.GameObjects.Graphics, o: OutlineLike, color: number, alpha = 1): void {
  g.lineStyle(2, color, alpha);
  if (o.circle) {
    g.strokeCircle(px(o.circle.center.x), px(o.circle.center.y), px(o.circle.radius));
    return;
  }
  for (let i = 0; i < o.points.length; i++) {
    const a = o.points[i];
    const b = o.points[(i + 1) % o.points.length];
    g.lineBetween(px(a.x), px(a.y), px(b.x), px(b.y));
  }
}

/** A short line from the head center shows which way a ragdoll faces. */
export function drawFace(g: Phaser.GameObjects.Graphics, head: Vec2, headAngle: number, facing: number): void {
  const dir = { x: Math.cos(headAngle) * facing, y: Math.sin(headAngle) * facing };
  g.lineStyle(2, 0xffffff, 0.8);
  g.lineBetween(px(head.x), px(head.y), px(head.x + dir.x * 0.18), px(head.y + dir.y * 0.18));
}

/** L7 spawn shield look (m / alpha): a bubble around the body in the player's colour; blinks while it runs out. */
const SHIELD_LOOK = { radius: 1.25, up: 0.15, fill: 0.12, edge: 0.75, blinkMs: 90 } as const;

/** L7: the spawn shield bubble around a body (`center`: torso), blinking in its last moments (`ending`). */
export function drawShield(g: Phaser.GameObjects.Graphics, center: Vec2, color: number, ending: boolean, nowMs: number): void {
  if (ending && Math.floor(nowMs / SHIELD_LOOK.blinkMs) % 2) return;
  const x = px(center.x);
  const y = px(center.y - SHIELD_LOOK.up);
  const r = px(SHIELD_LOOK.radius);
  g.fillStyle(color, SHIELD_LOOK.fill).fillCircle(x, y, r);
  g.lineStyle(2, color, SHIELD_LOOK.edge).strokeCircle(x, y, r);
  g.lineStyle(2, 0xffffff, SHIELD_LOOK.edge * 0.5).beginPath().arc(x, y, r - 4, -2.4, -1.4).strokePath(); // a glint
}

/** Health (green; light blue while protected) and stamina (yellow; red while arms are down) above a head. */
export function drawBars(
  g: Phaser.GameObjects.Graphics,
  head: Vec2,
  health: number,
  stamina: number,
  armsDown: boolean,
  isProtected: boolean,
): void {
  const x = px(head.x) - BAR.width / 2;
  const y = px(head.y - BAR.above) - BAR.height * 2 - BAR.gap;
  const bar = (row: number, share: number, color: number) => {
    g.fillStyle(0x000000, 0.6);
    g.fillRect(x - 1, y + row * (BAR.height + BAR.gap) - 1, BAR.width + 2, BAR.height + 2);
    g.fillStyle(color, 1);
    g.fillRect(x, y + row * (BAR.height + BAR.gap), BAR.width * Math.max(0, Math.min(1, share)), BAR.height);
  };
  bar(0, health, isProtected ? 0x80d8ff : 0x66bb6a);
  bar(1, stamina, armsDown ? 0xef5350 : 0xffca28);
}

/** L7: the faint dot at your aim point (no cursor, no ring): just enough to see which way you're aiming. */
export function drawAimDot(g: Phaser.GameObjects.Graphics, at: Vec2 | null, color: number): void {
  if (!at) return;
  g.fillStyle(color, AIM_POINT.dotAlpha).fillCircle(at.x * PX_PER_M, at.y * PX_PER_M, AIM_POINT.dotRadius * PX_PER_M);
}

/**
 * Dotted path (first PREVIEW_DOTS ticks) in your own colour, fading out along it; in debug also the full path and a
 * cross where it will hit. `points` must come from the same flight code as the real bullet (preview = reality).
 */
export function drawPreview(g: Phaser.GameObjects.Graphics, points: Vec2[], hit: Vec2 | null, debugOn: boolean, color = 0xffffff): void {
  const n = Math.min(points.length, PREVIEW_DOTS);
  for (let i = 2; i <= n; i += 2) if (points[i]) g.fillStyle(color, 0.95 * (1 - (0.75 * i) / PREVIEW_DOTS)).fillCircle(px(points[i].x), px(points[i].y), 2.8);
  if (!debugOn) return;
  g.lineStyle(1, 0x80deea, 0.35);
  for (let i = 1; i < points.length; i++) g.lineBetween(px(points[i - 1].x), px(points[i - 1].y), px(points[i].x), px(points[i].y));
  if (hit) {
    g.lineStyle(2, 0xff5252, 1);
    g.lineBetween(px(hit.x) - 6, px(hit.y) - 6, px(hit.x) + 6, px(hit.y) + 6);
    g.lineBetween(px(hit.x) - 6, px(hit.y) + 6, px(hit.x) + 6, px(hit.y) - 6);
  }
}

/** Pit kill zones: a near-black hole with dull red spikes at the bottom (still reads as "deadly" on the dark arenas). */
export function drawPits(g: Phaser.GameObjects.Graphics, pits: Rect[]): void {
  for (const p of pits) {
    g.fillStyle(0x030305, 0.9);
    g.fillRect(px(p.x), px(p.y), px(p.w), px(p.h));
    g.fillStyle(0x9a2a3a, 1);
    const spikes = Math.max(2, Math.round(p.w / 0.5));
    const w = p.w / spikes;
    for (let i = 0; i < spikes; i++) {
      const x = p.x + i * w;
      const bottom = p.y + p.h;
      g.fillTriangle(px(x), px(bottom), px(x + w), px(bottom), px(x + w / 2), px(bottom - 0.45));
    }
  }
}

export function floatText(scene: Phaser.Scene, at: Vec2, text: string, color: string, size: number): void {
  const t = scene.add.text(px(at.x), px(at.y), text, { fontFamily: 'monospace', fontSize: `${size}px`, color, fontStyle: 'bold', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(19);
  scene.tweens.add({ targets: t, y: t.y - 40, alpha: 0, duration: 900, ease: 'Cubic.easeOut', onComplete: () => t.destroy() });
}

/**
 * Shows one game event: floating damage / pickup text, or a kill-feed line (returned, if any).
 * `nameOf` turns player ids into display names.
 */
export function showGameEvent(scene: Phaser.Scene, ev: GameEvent, nameOf: (id: string) => string): string | null {
  if (ev.type === 'damage') {
    // L1: small numbers (callouts are their own event, drawn by CalloutLayer)
    floatText(scene, ev.pos, `-${ev.amount}`, ev.zone === 'head' ? '#ffd54f' : '#ff8a80', ev.zone === 'head' ? 13 : 11);
  } else if (ev.type === 'apple') {
    floatText(scene, ev.pos, ev.kind === 'red' ? '+HEALTH' : '+STAMINA', ev.kind === 'red' ? '#69f0ae' : '#ffd740', 13);
  } else if (ev.type === 'death') {
    const who = nameOf(ev.id);
    if (ev.cause === 'pit') return ev.killer ? `${nameOf(ev.killer)} dropped ${who} into the pit` : `${who} fell into the pit`;
    if (!ev.killer) return `${who} died`;
    if (ev.cause === 'shattered') return `${nameOf(ev.killer)} broke ${who} into pieces`;
    if (ev.cause === 'melee') return `${nameOf(ev.killer)} clobbered ${who}`;
    return `${nameOf(ev.killer)} ${ev.cause === 'out_of_arena' ? 'knocked out of the arena' : 'shot'} ${who}`;
  } else if (ev.type === 'crit') {
    // L5: a critical hit knocked the gun away (the DISARMED! banner is its callout)
    return ev.by ? `${nameOf(ev.by)} knocked ${nameOf(ev.id)}'s gun away: ${ev.weapon} time` : `${nameOf(ev.id)} lost the gun: ${ev.weapon} time`;
  } else if (ev.type === 'melee_hit') {
    if (ev.broke) floatText(scene, { x: ev.pos.x, y: ev.pos.y - 0.2 }, 'CRACK!', '#ffffff', 15);
  } else if (ev.type === 'respawn') {
    return `${nameOf(ev.id)} is back`;
  }
  return null;
}
