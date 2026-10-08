import Phaser from 'phaser';
import { ARROW, byteAngle, PICKUP, SPECIAL, TRACER_COLOR, type Pose, type Prop, type SpecialKind, type Vec2 } from '@ragdoll/shared';
import { floatText, px } from './draw';
import { drawGun } from './gun-draw';

/** How each special round looks (placeholder art) and what it's called on screen. */
export const SPECIAL_LOOK: Record<SpecialKind, { name: string; color: number; letter: string }> = {
  glove: { name: 'BOXING GLOVE', color: 0xff1744, letter: 'G' },
  balloon: { name: 'BALLOON', color: 0xff4fa3, letter: 'B' },
  oil: { name: 'OIL', color: 0x2e7d32, letter: 'O' },
  plunger: { name: 'PLUNGER', color: 0xd84315, letter: 'P' },
  bomb: { name: 'STICKY BOMB', color: 0x212121, letter: '!' },
  banana: { name: 'BANANA', color: 0xffd600, letter: 'Y' },
  swap: { name: 'SWAP', color: 0x7c4dff, letter: 'S' },
  feather: { name: 'FEATHER', color: 0xffffff, letter: 'F' },
};

/** A power-up bubble: a soap bubble with the round's colour and letter inside. */
export function drawBubble(scene: Phaser.Scene, g: Phaser.GameObjects.Graphics, label: string, pose: Pose, kind: SpecialKind | null, labels: Map<string, Phaser.GameObjects.Text>): void {
  const x = px(pose.x);
  const y = px(pose.y);
  const r = px(PICKUP.radius);
  const look = kind ? SPECIAL_LOOK[kind] : null;
  g.fillStyle(0xffffff, 0.35).fillCircle(x, y, r).lineStyle(3, 0x4fc3f7, 0.9).strokeCircle(x, y, r);
  if (look) g.fillStyle(look.color, 0.9).fillCircle(x, y, r * 0.55);
  g.fillStyle(0xffffff, 0.8).fillCircle(x - r * 0.4, y - r * 0.4, r * 0.15);
  let t = labels.get(label);
  if (!t) {
    t = scene.add.text(0, 0, '', { fontFamily: 'Impact, Arial Black, sans-serif', fontSize: '14px', color: '#ffffff', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5);
    labels.set(label, t);
  }
  t.setText(look?.letter ?? '?').setPosition(x, y).setVisible(true);
}

/**
 * A special round (L3): in flight a short tracer plus its coloured head (glove, bomb, ...); stuck on something (a
 * sticky bomb, a plunger with its rope) just the head. `pos` is its front.
 */
export function drawSpecialArrow(g: Phaser.GameObjects.Graphics, pos: Vec2, angle: number, kind: SpecialKind, flying: boolean, nowMs: number): void {
  const look = SPECIAL_LOOK[kind];
  if (flying) {
    const tail = { x: pos.x - Math.cos(angle) * ARROW.length, y: pos.y - Math.sin(angle) * ARROW.length };
    g.lineStyle(3, TRACER_COLOR, 1).lineBetween(px(tail.x), px(tail.y), px(pos.x), px(pos.y));
  }
  const x = px(pos.x);
  const y = px(pos.y);
  const blink = kind === 'bomb' && !flying && Math.floor(nowMs / 150) % 2 === 0;
  const r = kind === 'glove' ? 9 : kind === 'balloon' ? 7 : 6;
  g.fillStyle(blink ? 0xff1744 : look.color, 1).fillCircle(x, y, r).lineStyle(2, 0x000000, 1).strokeCircle(x, y, r);
  if (kind === 'bomb') g.lineStyle(2, 0x6d4c41, 1).lineBetween(x, y - r, x + 4, y - r - 6);
}

/**
 * Puddles, balloons (with strings), plunger ropes and knocked-away guns (L5). `partPos(slot, part)` / `handPos(slot)`
 * come from the poses on screen; `colorOf(slot)` is a player's colour (the stripe on their dropped gun).
 */
export function drawProps(
  g: Phaser.GameObjects.Graphics,
  props: Prop[],
  partPos: (slot: number, partIndex: number) => Vec2 | null,
  handPos: (slot: number) => Vec2 | null,
  colorOf: (slot: number) => number,
): void {
  for (const p of props) {
    if (p.type === 'puddle') {
      const w = p.a / 10;
      g.fillStyle(0x2e7d32, 0.85).fillEllipse(px(p.x), px(p.y) - 2, px(w), 10);
      g.fillStyle(0x9ccc65, 0.55).fillEllipse(px(p.x - w * 0.2), px(p.y) - 4, px(w * 0.3), 4);
    } else if (p.type === 'balloon') {
      const tied = partPos(p.a, p.b);
      if (tied) g.lineStyle(1.5, 0x37474f, 1).lineBetween(px(tied.x), px(tied.y), px(p.x), px(p.y) + px(SPECIAL.balloon.radius));
      const r = px(SPECIAL.balloon.radius);
      g.fillStyle(SPECIAL_LOOK.balloon.color, 1).fillEllipse(px(p.x), px(p.y), r * 2, r * 2.3).lineStyle(2, 0x000000, 0.8).strokeEllipse(px(p.x), px(p.y), r * 2, r * 2.3);
      g.fillStyle(0xffffff, 0.6).fillCircle(px(p.x) - r * 0.35, px(p.y) - r * 0.45, r * 0.18);
    } else if (p.type === 'rope') {
      const from = handPos(p.a);
      if (!from) continue;
      // a stretchy rope: a little sag in the middle
      const mid = { x: (from.x + p.x) / 2, y: (from.y + p.y) / 2 + 0.3 };
      g.lineStyle(3, 0xd84315, 1);
      g.beginPath().moveTo(px(from.x), px(from.y)).lineTo(px(mid.x), px(mid.y)).lineTo(px(p.x), px(p.y)).strokePath();
    } else if (p.type === 'gun') {
      // the prop is the gun body's center; the drawing's grip hand sits a little behind it (the gun is 1.1 m long)
      const angle = byteAngle(p.b);
      const hand = { x: p.x - Math.cos(angle) * 0.07, y: p.y - Math.sin(angle) * 0.07 };
      drawGun(g, { hand, angle, color: colorOf(p.a), ready: 1 });
    }
  }
}

/** One-off effects for S5 events: blast ring, balloon pop, wall dent, swap sparkle, pickup text. */
export class SpecialFx {
  private dents: { pos: Vec2; until: number }[] = [];

  constructor(private readonly scene: Phaser.Scene) {}

  explosion(pos: Vec2, radius: number): void {
    const g = this.scene.add.graphics().setDepth(14);
    g.fillStyle(0xffffff, 1).fillCircle(px(pos.x), px(pos.y), px(radius) * 0.4).lineStyle(6, 0xffab40, 1).strokeCircle(px(pos.x), px(pos.y), px(radius) * 0.4);
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 450, onComplete: () => g.destroy() });
    const ring = this.scene.add.graphics().setDepth(14);
    let r = 0.3;
    this.scene.tweens.addCounter({
      from: 0.3,
      to: radius,
      duration: 350,
      onUpdate: (tw) => {
        r = tw.getValue() ?? r;
        ring.clear().lineStyle(4, 0xffffff, 1 - r / radius).strokeCircle(px(pos.x), px(pos.y), px(r));
      },
      onComplete: () => ring.destroy(),
    });
  }

  pop(pos: Vec2): void {
    const g = this.scene.add.graphics().setDepth(14);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.lineStyle(3, SPECIAL_LOOK.balloon.color, 1).lineBetween(px(pos.x) + Math.cos(a) * 6, px(pos.y) + Math.sin(a) * 6, px(pos.x) + Math.cos(a) * 18, px(pos.y) + Math.sin(a) * 18);
    }
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 300, onComplete: () => g.destroy() });
    floatText(this.scene, pos, 'POP!', '#ff4fa3', 18);
  }

  /** A cartoon crack where someone hit a wall (stays a few seconds). */
  dent(pos: Vec2, nowMs: number): void {
    this.dents.push({ pos, until: nowMs + 4000 });
  }

  swap(at: Vec2[]): void {
    for (const p of at) floatText(this.scene, { x: p.x, y: p.y - 1 }, '✦', '#b388ff', 26);
  }

  pickup(pos: Vec2, kind: SpecialKind): void {
    floatText(this.scene, pos, `+${SPECIAL_LOOK[kind].name}`, '#ffffff', 16);
  }

  draw(g: Phaser.GameObjects.Graphics, nowMs: number): void {
    this.dents = this.dents.filter((d) => d.until > nowMs);
    for (const d of this.dents) {
      const x = px(d.pos.x);
      const y = px(d.pos.y);
      const a = Math.min(1, (d.until - nowMs) / 1000);
      g.lineStyle(2, 0xcfd8dc, 0.7 * a);
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + 0.4;
        g.lineBetween(x, y, x + Math.cos(ang) * 16, y + Math.sin(ang) * 16);
      }
    }
  }
}
