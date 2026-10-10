import Phaser from 'phaser';
import { colorOfSlot, GRAVITY_Y, LIMB, PART_NAMES, PART_SHAPES, PLAYER_COLORS, RAGDOLL, type ArenaPalette, type HatKind, type HazardDef, type Pose, type StaticShape, type Surface, type Vec2, type SpecialKind } from '@ragdoll/shared';
import { px } from './draw';
import { drawGun, drawMelee, gunOf, MELEE_LOOK } from './gun-draw';

/**
 * The SKIN: how players and the scene are drawn. L1 look: flat bright stick figures on dark, moody arenas (the
 * arena's palette; the sky and silhouettes are in backdrop.ts). It only draws what it's given (poses from
 * snapshots or the local world) and never decides anything. Debug view (F2) draws the physics outlines instead.
 */

/** Plain backgrounds: the debug view (F2), and before an arena's backdrop is built. */
export const SCENE = {
  background: '#0b0e14',
  debugBackground: '#111418',
} as const;

/** The player colours live in shared (the arena contrast test checks them); re-exported for the scenes. */
export { colorOfSlot, PLAYER_COLORS };

/**
 * L1 look numbers (meters). Flat bright stick figures: one colour, no outline, no face. The head is drawn at its
 * hitbox size (RAGDOLL.head.r × head scale), so what you see is what you can hit. Boots are physics only (not drawn).
 */
export const LOOK = {
  /** Thick round-ended limbs (drawing only): 0.14 m, about the width of their hitboxes (0.14-0.18 m). */
  limbWidth: 0.14,
  /** The torso is a thicker stick (its hitbox is 0.4 m wide). */
  torsoWidth: 0.2,
  /** L7: a whole leg is drawn as one smooth curve hip → knee → foot, in this many short sticks. */
  legSegments: 8,
  /** L7: just after landing the body is drawn this much wider / shorter (share), easing out over `ms`. */
  squash: { wider: 0.08, shorter: 0.1, ms: 140 },
  /** Back limbs are this much darker, for depth. */
  backShade: 0.68,
  /** Dead: the body turns this dark and fades to this alpha (no X eyes). */
  deadShade: 0.42,
  deadAlpha: 0.6,
  /** Hats and the crown are drawn this many head radii big (the head is smaller than the old cartoon head). */
  hatScale: 1.25,
} as const;

/** Everything the skin needs to draw one player. */
export interface BodyView {
  /** One pose per part, in PART_NAMES order. */
  parts: Pose[];
  /** L7: a moment after landing, 0..1: the body is drawn a little squashed (shorter and wider), from the feet. */
  squash?: number;
  facing: 1 | -1;
  alive: boolean;
  color: number;
  /** Head hitbox scale (Big Head Mode). */
  headScale: number;
  /** Cosmetic hat (S7); 'none' or missing = bare head (also after it was shot off). */
  hat?: HatKind;
  /** Wears the bounty crown (the match leader, S7). */
  crown?: boolean;
  /** Part index drawn white this frame (the 2-frame hit flash), if any. */
  flash?: number;
  /** L3: the gun in the front hand: reload progress (0 = just fired .. 1 = ready) and a loaded special round's colour. */
  gun?: { ready: number; special?: SpecialKind | null };
  /**
   * L4 body damage (bits by PART_NAMES index): parts shot off (drawn where they lie, with a flat cut; a lost shin
   * leaves a thigh stump), parts dented by a glove (drawn bent), and bullet holes (part index + spot in its frame).
   */
  lost?: number;
  dents?: number;
  holes?: { part: number; x: number; y: number }[];
  /** L5: the gun was knocked away: this melee weapon is in the front hand instead (`gun` is then not drawn). */
  melee?: 'bat' | 'mace';
  /** L5: limbs broken by melee hits (bits by PART_NAMES index of the upper part): a white crack at the elbow / knee. */
  broken?: number;
  /** L7: the leg being dragged (the limp): drawn wrapped in a white bandage. */
  bandaged?: 'front' | 'back' | null;
}

/** L4 damage look (meters / shades): the flat cut at a stump or a shot-off piece, a dent's bend, a hole. */
export const DAMAGE_LOOK = {
  /** Cut faces are this much darker than the part. */
  cutShade: 0.45,
  /** L7: a leg stump's end: a bright cap (no blood: cartoon), so a hopping player stands out across the arena. */
  stumpCap: 0xffd1dc,
  stumpCapRadius: 0.075,
  /** How far a dented limb bends sideways at its middle. */
  dentBend: 0.12,
  holeRadius: 0.032,
  hole: 0x07080c,
} as const;

type PartName = (typeof PART_NAMES)[number];
const IDX = Object.fromEntries(PART_NAMES.map((n, i) => [n, i])) as Record<PartName, number>;

/** The two ends of a box part along its long side, `hy` from its center (top, bottom). */
function ends(pose: Pose, hy: number): [Vec2, Vec2] {
  const dx = -Math.sin(pose.a) * hy;
  const dy = Math.cos(pose.a) * hy;
  return [
    { x: pose.x - dx, y: pose.y - dy },
    { x: pose.x + dx, y: pose.y + dy },
  ];
}

export const shade = (color: number, f: number): number => {
  const c = Phaser.Display.Color.IntegerToColor(color);
  return Phaser.Display.Color.GetColor(Math.min(255, c.red * f), Math.min(255, c.green * f), Math.min(255, c.blue * f));
};

/** A thick stick with round ends. */
function stick(g: Phaser.GameObjects.Graphics, a: Vec2, b: Vec2, color: number, width: number): void {
  const w = px(width);
  g.lineStyle(w, color, 1).lineBetween(px(a.x), px(a.y), px(b.x), px(b.y));
  g.fillStyle(color, 1).fillCircle(px(a.x), px(a.y), w / 2).fillCircle(px(b.x), px(b.y), w / 2);
}

/**
 * L7: when each body last landed (after a real jump or fall, at least `minAirTicks` in the air), for the landing squash.
 * Cosmetic: from what's drawn (the snapshot's or the local world's grounded flag).
 */
export class LandingSquash {
  private readonly bodies = new Map<string, { airSince: number | null; landedAt: number }>();
  constructor(private readonly minAirTicks = 12) {}

  /** This frame's squash (0..1) for body `id`, given whether it's on the ground at `tick`. */
  update(id: string, grounded: boolean, tick: number, nowMs: number): number {
    let b = this.bodies.get(id);
    if (!b) this.bodies.set(id, (b = { airSince: null, landedAt: -Infinity }));
    if (!grounded) b.airSince ??= tick;
    else if (b.airSince !== null) {
      if (tick - b.airSince >= this.minAirTicks) b.landedAt = nowMs;
      b.airSince = null;
    }
    return Math.max(0, 1 - (nowMs - b.landedAt) / LOOK.squash.ms);
  }
}

/** The colour a part is drawn in (front or back shade), e.g. for the chips of a hit on it. */
export function partColor(color: number, partIndex: number): number {
  const n = PART_NAMES[partIndex];
  return n && n.includes('Back') ? shade(color, LOOK.backShade) : color;
}

/**
 * L7 bandage on a dragged leg: off-white cloth, a shaded side and seams; wraps `wider` than the leg, one per `turn` m,
 * covering `cover` of each part's length, slanted by `slant` (share of a wrap's height).
 */
const BANDAGE_LOOK = { cloth: 0xf1ede2, shade: 0xd6cfbf, seam: 0xa99f8a, wider: 1.3, turn: 0.11, cover: 0.86, slant: 0.35 } as const;

/** Draws one player: back limbs (darker), torso, front limbs, head. Flat colour, no outline, no face. */
export function drawBody(g: Phaser.GameObjects.Graphics, b: BodyView): void {
  const front = b.alive ? b.color : shade(b.color, LOOK.deadShade);
  const back = shade(front, LOOK.backShade);
  const tint = (n: PartName, c: number) => (b.flash === IDX[n] ? 0xffffff : c);
  const lost = (n: PartName) => !!b.lost && (b.lost & (1 << IDX[n])) !== 0;
  const dented = (n: PartName) => !!b.dents && (b.dents & (1 << IDX[n])) !== 0;
  /** A flat, darker cut across a stick end (a stump, a shot-off piece). */
  const cut = (at: Vec2, along: Vec2, color: number) => {
    const n = { x: -along.y, y: along.x };
    const h = (LOOK.limbWidth / 2) * 1.05;
    g.lineStyle(px(0.035), shade(color, DAMAGE_LOOK.cutShade), 1).lineBetween(px(at.x + n.x * h), px(at.y + n.y * h), px(at.x - n.x * h), px(at.y - n.y * h));
  };
  // a limb part: a stick between the centers of its two joints (each box's long side, minus nothing: joints overlap)
  const limb = (n: PartName, color: number) => {
    const s = PART_SHAPES[n];
    const pose = b.parts[IDX[n]];
    const hy = 'hy' in s ? s.hy : 0;
    const c = tint(n, color);
    const lower = n === 'legFrontUpper' ? 'legFrontLower' : n === 'legBackUpper' ? 'legBackLower' : n === 'armFrontUpper' ? 'armFrontLower' : n === 'armBackUpper' ? 'armBackLower' : null;
    const isThigh = n === 'legFrontUpper' || n === 'legBackUpper';
    // L4: a thigh whose shin is gone is a stump: only its hip end is left (the physics shape shrank the same way)
    const len = isThigh && lower && lost(lower) ? 2 * hy * LIMB.stumpShare : 2 * hy;
    const dir = { x: -Math.sin(pose.a), y: Math.cos(pose.a) };
    const top = { x: pose.x - dir.x * hy, y: pose.y - dir.y * hy };
    const end = { x: top.x + dir.x * len, y: top.y + dir.y * len };
    if (dented(n)) {
      // L4: dented by a glove: bent at the middle, in the shape of a fist
      const mid = { x: (top.x + end.x) / 2 + dir.y * DAMAGE_LOOK.dentBend, y: (top.y + end.y) / 2 - dir.x * DAMAGE_LOOK.dentBend };
      stick(g, top, mid, c, LOOK.limbWidth);
      stick(g, mid, end, c, LOOK.limbWidth);
    } else stick(g, top, end, c, LOOK.limbWidth);
    if (lower && lost(lower)) cut(end, dir, color); // the stump / the arm where the forearm was shot off
    if (isThigh && lower && lost(lower)) g.fillStyle(DAMAGE_LOOK.stumpCap, 1).fillCircle(px(end.x), px(end.y), px(DAMAGE_LOOK.stumpCapRadius));
    if (lost(n)) cut(top, dir, color); // a shot-off piece lying around: its cut end
  };
  /**
   * L7: a whole leg (thigh + shin, nothing lost or dented) as one smooth curve from the hip through the knee to the
   * foot, so a bent knee reads as a springy bend, not two sticks; anything else draws its parts as before.
   */
  const leg = (upper: 'legFrontUpper' | 'legBackUpper', lowerName: 'legFrontLower' | 'legBackLower', color: number) => {
    if (lost(upper) || lost(lowerName) || dented(upper) || dented(lowerName) || b.flash === IDX[upper] || b.flash === IDX[lowerName]) {
      limb(upper, color);
      limb(lowerName, color);
      return;
    }
    const hyU = (PART_SHAPES[upper] as { hy: number }).hy;
    const hyL = (PART_SHAPES[lowerName] as { hy: number }).hy;
    const [hip, kneeA] = ends(b.parts[IDX[upper]], hyU);
    const [kneeB, foot] = ends(b.parts[IDX[lowerName]], hyL);
    const knee = { x: (kneeA.x + kneeB.x) / 2, y: (kneeA.y + kneeB.y) / 2 };
    // a quadratic curve through the knee at its middle: control = 2 * knee - (hip + foot) / 2
    const c = { x: 2 * knee.x - (hip.x + foot.x) / 2, y: 2 * knee.y - (hip.y + foot.y) / 2 };
    let prev = hip;
    for (let i = 1; i <= LOOK.legSegments; i++) {
      const t = i / LOOK.legSegments;
      const u = 1 - t;
      const p = { x: u * u * hip.x + 2 * u * t * c.x + t * t * foot.x, y: u * u * hip.y + 2 * u * t * c.y + t * t * foot.y };
      stick(g, prev, p, color, LOOK.limbWidth);
      prev = p;
    }
  };
  /**
   * L7: a dragged (limp) leg wrapped in a white bandage: overlapping wide wraps a bit wider than the leg, each slanted
   * like a turn of cloth, a shaded side and a seam where it overlaps the next, and a short loose end at the knee.
   */
  const bandageLeg = (upper: 'legFrontUpper' | 'legBackUpper', lowerName: 'legFrontLower' | 'legBackLower') => {
    const segs: [Vec2, Vec2][] = [
      ends(b.parts[IDX[upper]], (PART_SHAPES[upper] as { hy: number }).hy),
      ends(b.parts[IDX[lowerName]], (PART_SHAPES[lowerName] as { hy: number }).hy),
    ];
    const B = BANDAGE_LOOK;
    for (const [a, z] of segs) {
      const len = Math.hypot(z.x - a.x, z.y - a.y) || 1;
      const u = { x: (z.x - a.x) / len, y: (z.y - a.y) / len }; // along the leg
      const n = { x: -u.y, y: u.x }; // across it
      const half = (LOOK.limbWidth / 2) * B.wider;
      const turns = Math.max(2, Math.round(len / B.turn));
      const step = (len * B.cover) / turns;
      const start = (len * (1 - B.cover)) / 2;
      for (let i = 0; i < turns; i++) {
        const d0 = start + i * step;
        const d1 = d0 + step * 1.15; // (a little overlap with the next turn)
        const sk = B.slant * step; // the slant of a wrapped turn: one side higher than the other
        const p = (d: number, side: number) => ({ x: px(a.x + u.x * d + n.x * half * side), y: px(a.y + u.y * d + n.y * half * side) });
        const quad = [p(d0 - sk, -1), p(d0 + sk, 1), p(d1 + sk, 1), p(d1 - sk, -1)];
        g.fillStyle(B.cloth, 1).fillPoints(quad as Phaser.Math.Vector2[], true);
        // the shaded side (the leg is round under the cloth)
        const mid = (d: number, side: number) => ({ x: px(a.x + u.x * d + n.x * half * side * 0.15), y: px(a.y + u.y * d + n.y * half * side * 0.15) });
        g.fillStyle(B.shade, 1).fillPoints([mid(d0 + sk * 0.15, 1), p(d0 + sk, 1), p(d1 + sk, 1), mid(d1 + sk * 0.15, 1)] as Phaser.Math.Vector2[], true);
        // the seam where this turn overlaps the next
        g.lineStyle(Math.max(1, px(0.012)), B.seam, 1).lineBetween(quad[3].x, quad[3].y, quad[2].x, quad[2].y);
      }
    }
    // a short loose end hanging off the knee, fluttering a little
    const [, knee] = segs[0];
    const flap = Math.sin(performance.now() / 160) * 0.03;
    const tail = [
      { x: px(knee.x + 0.02), y: px(knee.y) },
      { x: px(knee.x - 0.04 * b.facing), y: px(knee.y + 0.02) },
      { x: px(knee.x - (0.16 + flap) * b.facing), y: px(knee.y + 0.13) },
      { x: px(knee.x - (0.11 + flap) * b.facing), y: px(knee.y + 0.15) },
    ];
    g.fillStyle(BANDAGE_LOOK.cloth, 1).fillPoints(tail as Phaser.Math.Vector2[], true);
    g.lineStyle(Math.max(1, px(0.01)), BANDAGE_LOOK.seam, 1).strokePoints(tail as Phaser.Math.Vector2[], true);
  };
  // L7: squashed a moment after landing (from the feet: shorter and wider)
  const squash = Math.max(0, Math.min(1, b.squash ?? 0));
  if (squash > 0) {
    const fx = (b.parts[IDX.legFrontLower].x + b.parts[IDX.legBackLower].x) / 2;
    const fy = Math.max(b.parts[IDX.legFrontLower].y, b.parts[IDX.legBackLower].y) + (PART_SHAPES.legFrontLower as { hy: number }).hy;
    g.save();
    g.translateCanvas(px(fx), px(fy));
    g.scaleCanvas(1 + LOOK.squash.wider * squash, 1 - LOOK.squash.shorter * squash);
    g.translateCanvas(-px(fx), -px(fy));
  }
  g.setAlpha(b.alive ? 1 : LOOK.deadAlpha);
  limb('armBackUpper', back);
  limb('armBackLower', back);
  leg('legBackUpper', 'legBackLower', back);
  if (b.bandaged === 'back' && !lost('legBackLower')) bandageLeg('legBackUpper', 'legBackLower');
  // torso: a thicker stick from neck to hips (its round ends stay inside the hitbox)
  const ts = PART_SHAPES.torso as { hx: number; hy: number };
  const [neck, hips] = ends(b.parts[IDX.torso], ts.hy - LOOK.torsoWidth / 2);
  if (dented('torso')) {
    const t = b.parts[IDX.torso];
    const mid = { x: t.x + Math.cos(t.a) * DAMAGE_LOOK.dentBend * b.facing, y: t.y + Math.sin(t.a) * DAMAGE_LOOK.dentBend * b.facing };
    stick(g, neck, mid, tint('torso', front), LOOK.torsoWidth);
    stick(g, mid, hips, tint('torso', front), LOOK.torsoWidth);
  } else stick(g, neck, hips, tint('torso', front), LOOK.torsoWidth);
  leg('legFrontUpper', 'legFrontLower', front);
  if (b.bandaged === 'front' && !lost('legFrontLower')) bandageLeg('legFrontUpper', 'legFrontLower');
  limb('armFrontUpper', front);
  limb('armFrontLower', front);
  if (b.melee && !lost('armFrontLower')) drawMelee(g, { ...gunOf(b.parts[IDX.armFrontLower]), weapon: b.melee, color: front, alpha: b.alive ? 1 : LOOK.deadAlpha });
  else if (b.gun) drawGun(g, { ...gunOf(b.parts[IDX.armFrontLower]), color: front, ready: b.gun.ready, special: b.gun.special, alpha: b.alive ? 1 : LOOK.deadAlpha });
  // L5: a limb broken by a melee hit: a white zigzag across its elbow / knee (it also hangs loose: that's the physics)
  for (const n of ['armFrontUpper', 'armBackUpper', 'legFrontUpper', 'legBackUpper'] as const) {
    if (!b.broken || !(b.broken & (1 << IDX[n])) || lost(n)) continue;
    const pose = b.parts[IDX[n]];
    const hy = (PART_SHAPES[n] as { hy: number }).hy;
    const [, joint] = ends(pose, hy * 0.75);
    const along = { x: -Math.sin(pose.a), y: Math.cos(pose.a) };
    const across = { x: -along.y, y: along.x };
    const w = LOOK.limbWidth * 0.8;
    const zig = [-1, -0.33, 0.33, 1].map((t, i) => ({ x: joint.x + across.x * w * t + along.x * (i % 2 ? 0.04 : -0.04), y: joint.y + across.y * w * t + along.y * (i % 2 ? 0.04 : -0.04) }));
    g.lineStyle(px(0.025), MELEE_LOOK.crack, 1);
    g.beginPath().moveTo(px(zig[0].x), px(zig[0].y));
    for (const z of zig.slice(1)) g.lineTo(px(z.x), px(z.y));
    g.strokePath();
  }
  // plain round head at its hitbox size
  const h = b.parts[IDX.head];
  const r = px(RAGDOLL.head.r * b.headScale);
  g.fillStyle(tint('head', front), 1).fillCircle(px(h.x), px(h.y), r);
  if (dented('head')) g.fillStyle(shade(front, DAMAGE_LOOK.cutShade), 1).fillCircle(px(h.x - Math.cos(h.a) * RAGDOLL.head.r * b.facing), px(h.y - Math.sin(h.a) * RAGDOLL.head.r * b.facing), r * 0.45);
  // L4: bullet holes: small dark see-through holes, carried by their part
  for (const hole of b.holes ?? []) {
    const pose = b.parts[hole.part];
    if (!pose) continue;
    // (on a thigh shot down to a stump, a hole in the part that's gone isn't drawn)
    const name = PART_NAMES[hole.part];
    const shin = name === 'legFrontUpper' ? 'legFrontLower' : name === 'legBackUpper' ? 'legBackLower' : null;
    if (shin && lost(shin) && hole.y > -RAGDOLL.upperLeg.hy * (1 - 2 * LIMB.stumpShare)) continue;
    const at = { x: pose.x + hole.x * Math.cos(pose.a) - hole.y * Math.sin(pose.a), y: pose.y + hole.x * Math.sin(pose.a) + hole.y * Math.cos(pose.a) };
    g.fillStyle(DAMAGE_LOOK.hole, 0.9).fillCircle(px(at.x), px(at.y), px(DAMAGE_LOOK.holeRadius));
  }
  const hatR = r * LOOK.hatScale;
  const hasHat = !!b.hat && b.hat !== 'none';
  if (hasHat) drawHat(g, b.hat!, px(h.x), px(h.y), hatR, h.a, b.facing);
  if (b.crown) drawCrown(g, px(h.x), px(h.y), hatR, h.a, hasHat ? 1.55 : 1);
  if (squash > 0) g.restore();
  g.setAlpha(1);
}

/** Head-local point (units of head radius; y down, 0,-1 = top of head) to screen px, turned with the head. */
const onHead = (cx: number, cy: number, r: number, a: number) => (x: number, y: number) =>
  new Phaser.Math.Vector2(cx + (x * Math.cos(a) - y * Math.sin(a)) * r, cy + (x * Math.sin(a) + y * Math.cos(a)) * r);

/** Hat shapes (S7), flat colours like the bodies, sitting on the head (`r` = hat size in px, ~ the head radius). */
export function drawHat(g: Phaser.GameObjects.Graphics, kind: HatKind, cx: number, cy: number, r: number, a: number, facing: 1 | -1): void {
  const at = onHead(cx, cy, r, a);
  const poly = (pts: [number, number][], fill: number) => {
    g.fillStyle(fill, 1).fillPoints(
      pts.map(([x, y]) => at(x * facing, y)),
      true,
    );
  };
  const dot = (x: number, y: number, rr: number, fill: number) => {
    const c = at(x * facing, y);
    g.fillStyle(fill, 1).fillCircle(c.x, c.y, rr * r);
  };
  switch (kind) {
    case 'cap':
      poly([[-0.85, -0.45], [-0.6, -0.95], [0, -1.08], [0.6, -0.95], [0.85, -0.45]], 0xe53935);
      poly([[0.6, -0.5], [1.45, -0.42], [1.4, -0.3], [0.6, -0.36]], 0xb71c1c);
      break;
    case 'party':
      poly([[-0.55, -0.82], [0.1, -2.05], [0.6, -0.8]], 0xab47bc);
      dot(0.1, -2.05, 0.16, 0xffeb3b);
      break;
    case 'tophat':
      // charcoal, not black: it has to show against the dark sky
      poly([[-1.05, -0.78], [1.05, -0.78], [1.05, -0.92], [-1.05, -0.92]], 0x4a4a58);
      poly([[-0.62, -0.9], [0.62, -0.9], [0.62, -1.95], [-0.62, -1.95]], 0x4a4a58);
      poly([[-0.62, -1.05], [0.62, -1.05], [0.62, -1.2], [-0.62, -1.2]], 0xc62828);
      break;
    case 'viking':
      poly([[-1.15, -0.4], [-1.45, -1.3], [-0.8, -0.75]], 0xfff8e1);
      poly([[1.15, -0.4], [1.45, -1.3], [0.8, -0.75]], 0xfff8e1);
      poly([[-0.95, -0.35], [-0.75, -0.9], [0, -1.12], [0.75, -0.9], [0.95, -0.35]], 0x90a4ae);
      break;
    case 'chef':
      poly([[-0.65, -0.75], [0.65, -0.75], [0.65, -1.15], [-0.65, -1.15]], 0xffffff);
      dot(-0.45, -1.4, 0.38, 0xffffff);
      dot(0.45, -1.4, 0.38, 0xffffff);
      dot(0, -1.6, 0.42, 0xffffff);
      break;
    case 'propeller': {
      poly([[-0.85, -0.45], [-0.6, -0.95], [0, -1.08], [0.6, -0.95], [0.85, -0.45]], 0x1e88e5);
      const spin = Math.sin(performance.now() / 40);
      poly([[0, -1.25], [0.9 * spin, -1.32], [0.9 * spin, -1.18]], 0xffeb3b);
      poly([[0, -1.25], [-0.9 * spin, -1.32], [-0.9 * spin, -1.18]], 0xf44336);
      dot(0, -1.18, 0.08, 0xcfd8dc);
      break;
    }
    case 'traffic_cone':
      poly([[-0.85, -0.72], [0.85, -0.72], [0.85, -0.86], [-0.85, -0.86]], 0xff6d00);
      poly([[-0.62, -0.86], [0.62, -0.86], [0.12, -2.1], [-0.12, -2.1]], 0xff6d00);
      poly([[-0.43, -1.35], [0.43, -1.35], [0.33, -1.6], [-0.33, -1.6]], 0xffffff);
      break;
    case 'none':
      break;
  }
}

/** The bounty crown: gold, on top of the head (and above a hat: `lift`). */
export function drawCrown(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number, a: number, lift: number): void {
  const at = onHead(cx, cy, r, a);
  const y0 = -0.85 * lift - 0.05;
  const pts = [[-0.62, y0], [0.62, y0], [0.72, y0 - 0.75], [0.36, y0 - 0.38], [0, y0 - 0.85], [-0.36, y0 - 0.38], [-0.72, y0 - 0.75]].map(([x, y]) => at(x, y));
  g.fillStyle(0xffd600, 1).fillPoints(pts, true);
  const gem = at(0, y0 - 0.2);
  g.fillStyle(0xe53935, 1).fillCircle(gem.x, gem.y, r * 0.11);
}

/** Hats knocked off by a headshot: they tumble away and fade (cosmetic; the hat is back on at respawn). */
export class FlyingHats {
  private list: { kind: HatKind; pos: Vec2; vel: Vec2; angle: number; spin: number; age: number; facing: 1 | -1 }[] = [];

  add(kind: HatKind, head: Vec2, from: Vec2, facing: 1 | -1): void {
    const dir = Math.sign(head.x - from.x) || 1;
    this.list.push({ kind, pos: { ...head }, vel: { x: dir * (2 + Math.random() * 1.5), y: -5 - Math.random() * 2 }, angle: 0, spin: dir * (8 + Math.random() * 6), age: 0, facing });
  }

  draw(g: Phaser.GameObjects.Graphics, dt: number): void {
    const life = 1.4;
    this.list = this.list.filter((h) => (h.age += dt) < life);
    for (const h of this.list) {
      h.vel.y += GRAVITY_Y * dt;
      h.pos = { x: h.pos.x + h.vel.x * dt, y: h.pos.y + h.vel.y * dt };
      h.angle += h.spin * dt;
      g.setAlpha(Math.min(1, 2 * (1 - h.age / life)));
      drawHat(g, h.kind, px(h.pos.x), px(h.pos.y + RAGDOLL.head.r), px(RAGDOLL.head.r) * LOOK.hatScale, h.angle, h.facing);
    }
    g.setAlpha(1);
  }
}

/** Floor looks for the S6 surfaces (still a dark block, with its own edge colour): ice pale cyan, bouncy pink. */
export const SURFACE_LOOK = { ice: { fill: 0x15303a, edge: 0x80deea }, bouncy: { fill: 0x351528, edge: 0xff80ab } } as const;
/** Accent edge thickness (px). */
const EDGE_PX = 3;

/** Scenery block: a dark terrain silhouette with the palette's bright accent edge on top. */
export function drawStatic(g: Phaser.GameObjects.Graphics, s: StaticShape, palette: ArenaPalette, surface?: Surface): void {
  if (!('hx' in s.shape)) return;
  const { hx, hy } = s.shape;
  const look = surface ? SURFACE_LOOK[surface] : null;
  const x = px(s.pos.x - hx);
  const y = px(s.pos.y - hy);
  g.fillStyle(look?.fill ?? palette.terrain, 1).fillRect(x, y, px(hx * 2), px(hy * 2));
  g.fillStyle(look?.edge ?? palette.accent, 1).fillRect(x, y, px(hx * 2), EDGE_PX);
}

/** Crate (box), apple (ball) or wrecking ball. Crates and the ball are dull scenery; apples are bright (pickups). */
export function drawMovable(g: Phaser.GameObjects.Graphics, label: string, shape: StaticShape['shape'], pose: Pose): void {
  if ('r' in shape && label.startsWith('wreck')) {
    g.fillStyle(0x37434b, 1).fillCircle(px(pose.x), px(pose.y), px(shape.r)).lineStyle(2, 0x78909c, 1).strokeCircle(px(pose.x), px(pose.y), px(shape.r));
    g.fillStyle(0xffffff, 0.2).fillCircle(px(pose.x - shape.r * 0.35), px(pose.y - shape.r * 0.35), px(shape.r * 0.2));
    return;
  }
  if ('r' in shape) {
    const gold = label.startsWith('apple:gold');
    g.fillStyle(gold ? 0xffc400 : 0xff3d3d, 1).fillCircle(px(pose.x), px(pose.y), px(shape.r));
    g.fillStyle(0x3fa34d, 1).fillEllipse(px(pose.x + shape.r * 0.35), px(pose.y - shape.r), px(shape.r * 0.7), px(shape.r * 0.35));
    return;
  }
  const { hx, hy } = shape;
  const pts = [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ].map(([x, y]) => new Phaser.Math.Vector2(px(pose.x + x * Math.cos(pose.a) - y * Math.sin(pose.a)), px(pose.y + x * Math.sin(pose.a) + y * Math.cos(pose.a))));
  g.fillStyle(0x3b2c22, 1).fillPoints(pts, true).lineStyle(2, 0x7a5c46, 1).strokePoints(pts, true);
  g.lineStyle(2, 0x7a5c46, 0.7).lineBetween(pts[0].x, pts[0].y, pts[2].x, pts[2].y).lineBetween(pts[1].x, pts[1].y, pts[3].x, pts[3].y);
}

/** L7 wind specks: how faint (peak alpha), how big (px), how many (one per this many m²), how fast (wind boxes per s). */
const WIND_LOOK = { alpha: 0.22, radius: 1.6, areaPerSpeck: 10, speed: 0.35 } as const;

/**
 * Hazards drawn on top of the scenery (S6): trampoline strips, conveyor belts (moving chevrons), wind boxes
 * (a few faint drifting specks) and wrecking-ball chains. Seesaw planks and the balls themselves are bodies (drawMovable).
 */
export function drawHazards(g: Phaser.GameObjects.Graphics, hazards: HazardDef[], nowMs: number, ballAt: (label: string) => Vec2 | null): void {
  for (const h of hazards) {
    if (h.kind === 'trampoline') {
      g.fillStyle(0xff1744, 1).fillRect(px(h.x), px(h.y) - 6, px(h.w), 6);
      g.lineStyle(2, 0x5a0a18, 1);
      for (let i = 1; i < 4; i++) g.lineBetween(px(h.x + (h.w * i) / 4), px(h.y) - 6, px(h.x + (h.w * i) / 4) - 4, px(h.y) - 12);
    } else if (h.kind === 'conveyor') {
      g.fillStyle(0x37474f, 1).fillRect(px(h.x), px(h.y) - 5, px(h.w), 5);
      const step = 0.4;
      const shift = (((nowMs / 1000) * h.speed) % step + step) % step;
      g.lineStyle(2, 0xffd600, 1);
      for (let x = h.x + shift; x < h.x + h.w; x += step) {
        const d = Math.sign(h.speed) * 0.1;
        g.lineBetween(px(x - d), px(h.y) - 4, px(x), px(h.y) - 2.5).lineBetween(px(x), px(h.y) - 2.5, px(x - d), px(h.y) - 1);
      }
    } else if (h.kind === 'wind') {
      // L7 clean look: no tinted box and no streaks (they looked like bullets). A few tiny faint specks drift with the
      // wind, fading in and out; the aim preview's bend shows the rest.
      const len = Math.hypot(h.ax, h.ay) || 1;
      const dir = { x: h.ax / len, y: h.ay / len };
      const count = Math.max(2, Math.round((h.w * h.h) / WIND_LOOK.areaPerSpeck));
      for (let i = 0; i < count; i++) {
        const t = ((nowMs / 1000) * WIND_LOOK.speed + i * 0.137) % 1;
        const sx = h.x + ((i * 0.37) % 1) * h.w;
        const sy = h.y + ((i * 0.61) % 1) * h.h;
        const x = h.x + ((sx - h.x + t * h.w * dir.x + h.w) % h.w);
        const y = h.y + ((sy - h.y + t * h.h * dir.y + h.h) % h.h);
        g.fillStyle(0xffffff, WIND_LOOK.alpha * Math.sin(Math.PI * t)).fillCircle(px(x), px(y), WIND_LOOK.radius);
      }
    } else if (h.kind === 'wrecking_ball') {
      const ball = ballAt(h.label);
      if (ball) g.lineStyle(3, 0x607080, 1).lineBetween(px(h.x), px(h.y), px(ball.x), px(ball.y));
    }
  }
}
