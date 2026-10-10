import type { ArenaPalette } from './arena';

/**
 * L1 look: "moody world, bright players". The colours every screen agrees on, plus the readability check that every
 * arena palette must pass. Colours are 0xRRGGBB numbers (they travel in the arena info as plain JSON).
 *
 * Why here and not in the client: the arena palettes are data in `shared/`, and the test that checks them needs the
 * player and tracer colours. The client's skin imports these, so there is one source of truth.
 */

/**
 * One flat bright colour per player slot (8 kept apart; more slots reuse them). Tuned for dark arenas: the purple
 * and the red were brightened (0xa64dff -> 0xb388ff, 0xff1744 -> 0xff3355) to pass the contrast check below.
 */
export const PLAYER_COLORS = [0x00e5ff, 0xff2bd6, 0x76ff03, 0xffea00, 0xff6d00, 0xb388ff, 0xff3355, 0x82b1ff] as const;

/** A flying projectile (arrow now, bullet tracer in L3): bright warm white. */
export const TRACER_COLOR = 0xfff59d;

export const colorOfSlot = (slot: number): number => PLAYER_COLORS[(slot - 1 + PLAYER_COLORS.length) % PLAYER_COLORS.length];

/**
 * M3 Team Battle: each team wears shades of its own colour (warm reds, cool blues), so you see the team at a glance and
 * still tell teammates apart. Checked against every arena like the player colours.
 */
export const TEAM_COLORS = [
  [0xff3355, 0xff7a45, 0xff5fa2, 0xffb02e],
  [0x00e5ff, 0x82b1ff, 0x6a9bff, 0x7cf5d2],
] as const;

/** A team member's colour: `n` = their place in the team (by slot), so shades don't change while they play. */
export const teamColor = (team: 0 | 1, n: number): number => TEAM_COLORS[team][n % TEAM_COLORS[team].length];

/** Readability rules for arena palettes (section 6 of modifications.md). */
export const LOOK_RULES = {
  /**
   * Least contrast (WCAG ratio, 1..21) between every player colour / the tracer and every backdrop colour.
   * 3 is the WCAG minimum for graphics; moving thin things need at least that.
   */
  minContrast: 3,
  /** The backdrop is the darkest thing: no backdrop colour may be brighter than this (relative luminance 0..1). */
  maxBackdropLuminance: 0.05,
  /** ...and the dullest: chroma (max - min of the 0..1 RGB channels) at most this. Players are ~1. */
  maxBackdropChroma: 0.3,
  /** Glows are soft light, not lamps you could mistake for something: at most this opaque. */
  maxGlowAlpha: 0.3,
  /**
   * L7 clean look: at most one far layer (none in today's arenas). Busy silhouettes behind the fight read as noise
   * next to flying bullets, so a layer must also stay barely visible against the sky (`maxLayerContrast`).
   */
  layers: { min: 0, max: 1 },
  maxLayerContrast: 1.3,
} as const;

const channel = (c: number, shift: number) => ((c >> shift) & 0xff) / 255;
export const rgb = (c: number): [number, number, number] => [channel(c, 16), channel(c, 8), channel(c, 0)];

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(c: number): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(c).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 = same, 21 = black on white). */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** How colourful: max - min of the RGB channels (0 = grey). */
export function chroma(c: number): number {
  const v = rgb(c);
  return Math.max(...v) - Math.min(...v);
}

/** `top` painted over `under` at `alpha` (what a glow looks like at its brightest). */
export function blend(top: number, under: number, alpha: number): number {
  const a = rgb(top);
  const b = rgb(under);
  const mix = (i: number) => Math.round((a[i] * alpha + b[i] * (1 - alpha)) * 255);
  return (mix(0) << 16) | (mix(1) << 8) | mix(2);
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Every colour a player can be seen against: sky ends, glows at their brightest, layers, terrain. */
export function backdropColors(p: ArenaPalette): { name: string; color: number }[] {
  const out = [
    { name: 'sky.top', color: p.sky.top },
    { name: 'sky.bottom', color: p.sky.bottom },
    ...p.layers.map((l, i) => ({ name: `layer ${i} (${l.kind})`, color: l.color })),
    { name: 'terrain', color: p.terrain },
  ];
  // a glow lies over the sky: check it over the brighter sky end, at its strongest
  const brightSky = luminance(p.sky.top) > luminance(p.sky.bottom) ? p.sky.top : p.sky.bottom;
  for (const [i, g] of (p.glow ?? []).entries()) out.push({ name: `glow ${i}`, color: blend(g.color, brightSky, g.alpha) });
  // L7: aurora curtains, at their brightest (the foot colour at full alpha over the bright sky end)
  for (const [i, a] of (p.aurora ?? []).entries()) out.push({ name: `aurora ${i}`, color: blend(a.color, brightSky, a.alpha) });
  return out;
}

/** Problems with a palette (empty = good). Run by the arena validator on every arena that has one. */
export function paletteProblems(p: ArenaPalette, where = 'palette'): string[] {
  const out: string[] = [];
  const all = [p.sky.top, p.sky.bottom, p.terrain, p.accent, p.dust, ...p.layers.map((l) => l.color), ...(p.glow ?? []).map((g) => g.color), ...(p.aurora ?? []).flatMap((a) => [a.color, a.top])];
  if (!all.every((c) => Number.isInteger(c) && c >= 0 && c <= 0xffffff)) out.push(`${where}: a colour is not a 0xRRGGBB number`);
  if (p.layers.length < LOOK_RULES.layers.min || p.layers.length > LOOK_RULES.layers.max) out.push(`${where}: ${p.layers.length} parallax layers, needs ${LOOK_RULES.layers.min}-${LOOK_RULES.layers.max}`);
  if (!Number.isFinite(p.horizon)) out.push(`${where}: horizon is not a number`);
  p.layers.forEach((l, i) => {
    if (!(l.depth > 0 && l.depth < 1)) out.push(`${where}: layer ${i} depth ${l.depth} must be between 0 and 1`);
    if (!(l.height > 0)) out.push(`${where}: layer ${i} height must be above 0`);
    const vsSky = Math.max(contrastRatio(l.color, p.sky.top), contrastRatio(l.color, p.sky.bottom));
    if (vsSky > LOOK_RULES.maxLayerContrast) out.push(`${where}: layer ${i} (${hex(l.color)}) stands out from the sky (contrast ${vsSky.toFixed(2)} > ${LOOK_RULES.maxLayerContrast}); keep the backdrop quiet`);
    const nearer = p.layers[i + 1];
    if (!nearer) return;
    // Shadow Fight depth: farther = moves less and is lighter (hazier)
    if (!(l.depth < nearer.depth)) out.push(`${where}: layer ${i} must move less than layer ${i + 1} (listed far to near)`);
    if (luminance(l.color) < luminance(nearer.color)) out.push(`${where}: layer ${i} (${hex(l.color)}) is darker than the nearer layer ${i + 1} (${hex(nearer.color)}); farther layers are lighter`);
  });
  for (const [i, a] of (p.aurora ?? []).entries()) {
    if (!(a.y >= 0 && a.y <= 1 && a.height > 0 && a.height <= 1 && a.fold >= 0)) out.push(`${where}: aurora ${i} must sit on the screen (y 0..1, height 0..1)`);
    if (!(a.alpha > 0 && a.alpha <= LOOK_RULES.maxGlowAlpha)) out.push(`${where}: aurora ${i} alpha ${a.alpha} must be in (0, ${LOOK_RULES.maxGlowAlpha}]`);
  }
  for (const [i, g] of (p.glow ?? []).entries()) {
    if (!(g.x >= 0 && g.x <= 1 && g.y >= 0 && g.y <= 1 && g.radius > 0)) out.push(`${where}: glow ${i} must sit on the screen (x, y 0..1, radius > 0)`);
    if (!(g.alpha > 0 && g.alpha <= LOOK_RULES.maxGlowAlpha)) out.push(`${where}: glow ${i} alpha ${g.alpha} must be in (0, ${LOOK_RULES.maxGlowAlpha}]`);
  }
  // Readability: the backdrop is the darkest, dullest thing; players and shots the brightest.
  for (const b of backdropColors(p)) {
    if (luminance(b.color) > LOOK_RULES.maxBackdropLuminance) out.push(`${where}: ${b.name} ${hex(b.color)} is too bright for a backdrop (luminance ${luminance(b.color).toFixed(3)})`);
    if (chroma(b.color) > LOOK_RULES.maxBackdropChroma) out.push(`${where}: ${b.name} ${hex(b.color)} is too colourful for a backdrop`);
    const front = [
      ...PLAYER_COLORS.map((c, i) => ({ name: `player ${i + 1}`, color: c })),
      ...TEAM_COLORS.flatMap((cs, t) => cs.map((c, i) => ({ name: `team ${t} shade ${i + 1}`, color: c }))),
      { name: 'tracer', color: TRACER_COLOR },
    ];
    for (const f of front) {
      const ratio = contrastRatio(f.color, b.color);
      if (ratio < LOOK_RULES.minContrast) out.push(`${where}: ${f.name} ${hex(f.color)} on ${b.name} ${hex(b.color)}: contrast ${ratio.toFixed(2)} < ${LOOK_RULES.minContrast}`);
    }
  }
  return out;
}

/** The look of an arena without its own palette (test arenas, drafts): plain dark blue-grey, no silhouettes. */
export const DEFAULT_PALETTE: ArenaPalette = {
  sky: { top: 0x0b0e14, bottom: 0x1a2130 },
  horizon: 17,
  layers: [],
  terrain: 0x0e1117,
  accent: 0x8fa3bf,
  dust: 0x5c6675,
  seed: 1,
};
