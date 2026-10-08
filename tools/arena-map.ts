// Draws arenas from their data files, with each part labeled (the picture is made from the same data the game
// builds, so it's always exact).
//   npx tsx tools/arena-map.ts                  every arena in ARENAS -> arena-maps.html
//   npx tsx tools/arena-map.ts <draft.ts> ...   draft arenas (not in the game yet), both sizes, plus the validator's
//                                               verdict -> arena-drafts.html
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARENAS, arenaLayout, arenaReach, describeSurface, PIT_KILL_BELOW, validateArena, type ArenaDef, type ArenaSize } from '../shared/src';

/** Pixels per meter in the map. */
const S = 20;
/** What one screen shows (m): the camera's 36 m width (client CAMERA.viewWidth, L3) on a 16:9 screen. */
const SCREEN = { w: 36, h: 20.25 };

const COLORS = {
  sky: '#cdeee2',
  ground: '#f7b267',
  solid: '#f3f0ea',
  edge: '#6d5a4b',
  ice: '#b3e5fc',
  bouncy: '#ff8ac8',
  crate: '#c98b4b',
  pit: '#5d4037',
  text: '#10262e',
};

/** Friendly names for data labels (anything not listed shows its raw label). */
function nameOf(label: string): string {
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^ground(_\d+)?$/, () => 'Ground'],
    [/^pit_floor/, () => ''],
    [/_floor$/, () => ''],
    [/^roof_far_[lr]$/, () => 'Lower rooftop'],
    [/^roof_[lr](_edge)?$/, () => 'Rooftop'],
    [/^roof_[lr]_under$/, () => ''],
    [/^skylight_[lr]$/, () => 'Skylight'],
    [/^hut_[lr]$/, () => 'Stairwell hut'],
    [/^tower_[lr]$/, () => 'Water tower deck'],
    [/^ac_[lr]$/, () => 'AC unit'],
    [/^step_([lr])(\d)$/, (m) => `Step ${m[2]}`],
    [/^bridge_([lr])$/, (m) => `${m[1] === 'l' ? 'Left' : 'Right'} bridge`],
    [/^perch_([lr])$/, () => 'High perch'],
    [/^bouncer/, () => 'Bouncy block'],
    [/^cover/, () => 'Low cover'],
    [/^thin_wall$/, () => 'Thin wall (0.1 m)'],
    [/^platform$/, () => 'Platform'],
  ];
  for (const [re, f] of rules) {
    const m = label.match(re);
    if (m) return f(m);
  }
  return label;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const px = (m: number) => +(m * S).toFixed(1);

function text(x: number, y: number, t: string, opts: { size?: number; anchor?: string; color?: string; bold?: boolean; halo?: boolean } = {}): string {
  const { size = 12, anchor = 'middle', color = COLORS.text, bold = false, halo = true } = opts;
  const style = `font: ${bold ? '700 ' : ''}${size}px system-ui, sans-serif; text-anchor: ${anchor};`;
  const h = halo ? `<text x="${x}" y="${y}" style="${style}" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round" fill="none">${esc(t)}</text>` : '';
  return `${h}<text x="${x}" y="${y}" style="${style}" fill="${color}">${esc(t)}</text>`;
}

function arenaSvg(def: ArenaDef, size: ArenaSize = 'full'): string {
  const a = arenaLayout(def, size);
  const W = px(a.width);
  const H = px(a.height);
  const top = 34; // room for the title row
  const out: string[] = [];
  out.push(`<svg viewBox="0 0 ${W} ${H + top}" width="${W}" height="${H + top}" xmlns="http://www.w3.org/2000/svg">`);
  out.push(`<g transform="translate(0 ${top})">`);
  out.push(`<rect width="${W}" height="${H}" fill="${COLORS.sky}"/>`);
  // one screen, for scale (top-left corner)
  out.push(`<rect x="2" y="2" width="${px(Math.min(SCREEN.w, a.width)) - 4}" height="${px(Math.min(SCREEN.h, a.height)) - 4}" fill="none" stroke="#7a9c90" stroke-width="1.5" stroke-dasharray="3 5"/>`);
  out.push(text(8, 16, `one screen (${SCREEN.w} x ${SCREEN.h} m)`, { size: 11, anchor: 'start', color: '#4f6f63' }));

  // wind boxes go behind everything
  for (const h of a.hazards) {
    if (h.kind !== 'wind') continue;
    // wind can reach above the arena (high arrows fly there): draw the part inside it, and say it goes on up
    const sky = h.y < 0;
    if (sky) h.h += h.y, h.y = 0;
    out.push(`<rect x="${px(h.x)}" y="${px(h.y)}" width="${px(h.w)}" height="${px(h.h)}" fill="#ffffff" fill-opacity="0.45" stroke="#90a4ae" stroke-dasharray="6 4"/>`);
    const len = Math.hypot(h.ax, h.ay) || 1;
    const d = { x: h.ax / len, y: h.ay / len };
    // a few arrows along the wind, spread over the box
    const n = Math.max(3, Math.round((Math.abs(d.x) > 0.5 ? h.h : h.w) / 2.5));
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const c = { x: h.x + (Math.abs(d.x) > 0.5 ? h.w / 2 : h.w * f), y: h.y + (Math.abs(d.x) > 0.5 ? h.h * f : h.h / 2) };
      const half = Math.min(Math.abs(d.x) > 0.5 ? h.w : h.h, 8) * 0.3;
      out.push(`<line x1="${px(c.x - d.x * half)}" y1="${px(c.y - d.y * half)}" x2="${px(c.x + d.x * half)}" y2="${px(c.y + d.y * half)}" stroke="#78909c" stroke-width="2" marker-end="url(#arrow)"/>`);
    }
    const way = Math.abs(d.y) > Math.abs(d.x) ? (d.y < 0 ? 'up' : 'down') : d.x > 0 ? 'right' : 'left';
    const label = `${h.label.toUpperCase().replace(/_/g, ' ')}: wind ${way} (${len} m/s²)`;
    out.push(text(px(h.x + h.w / 2), px(h.y) + 16, label, { bold: true, size: 12 }));
    if (sky) out.push(text(px(h.x + h.w / 2), px(h.y) + 30, '(goes on up into the sky)', { size: 10 }));
  }

  // pits: dark kill zone
  for (const p of a.pits) {
    out.push(`<rect x="${px(p.x)}" y="${px(p.y - PIT_KILL_BELOW)}" width="${px(p.w)}" height="${px(p.h + PIT_KILL_BELOW)}" fill="${COLORS.pit}"/>`);
    for (let x = p.x + 0.25; x < p.x + p.w; x += 0.5) out.push(`<path d="M${px(x - 0.2)} ${px(p.y + p.h)} L${px(x)} ${px(p.y + p.h) - 8} L${px(x + 0.2)} ${px(p.y + p.h)} Z" fill="#e57373"/>`);
    const short = p.w < 8;
    out.push(text(px(p.x + p.w / 2), px(p.y + p.h / 2) + (short ? -2 : 4), short ? 'PIT' : 'PIT (fall in = ring out)', { bold: true, size: 12, color: '#ffffff', halo: false }));
    if (short) out.push(text(px(p.x + p.w / 2), px(p.y + p.h / 2) + 12, 'ring out', { size: 10, color: '#ffffff', halo: false }));
  }

  // solids
  for (const s of a.solids) {
    const fill = s.surface ? COLORS[s.surface] : s.label.startsWith('ground') || s.label.startsWith('pit_floor') ? COLORS.ground : COLORS.solid;
    out.push(`<rect x="${px(s.x)}" y="${px(s.y)}" width="${px(s.w)}" height="${px(s.h)}" fill="${fill}" stroke="${COLORS.edge}" stroke-opacity="0.6"/>`);
  }
  for (const s of a.solids) {
    let name = nameOf(s.label);
    if (!name) continue;
    if (s.surface && !name.toLowerCase().includes(s.surface)) name += s.surface === 'ice' ? ' (ICE)' : ' (BOUNCY)';
    // ground: one label per piece, inside it; others just above (or inside if tall)
    if (name === 'Ground') {
      out.push(text(px(s.x + s.w / 2), px(s.y) + Math.min(22, px(s.h) - 4), 'Ground', { size: 12, halo: false, color: '#7a4b16' }));
      continue;
    }
    const tall = s.h >= 0.9 && s.w >= 3;
    // thin ledges are labeled underneath (things stand on top of them)
    const ledge = s.h <= 0.5 && s.w >= 2;
    // steps: label at their outer, uncovered end so stacked steps don't overlap
    const isStep = /^step_/.test(s.label);
    const cx = isStep ? (s.label.includes('_l') ? s.x + 1.1 : s.x + s.w - 1.1) : s.x + s.w / 2;
    out.push(text(px(cx), tall ? px(s.y + s.h / 2) + 4 : ledge ? px(s.y + s.h) + 14 : px(s.y) - 5, name, { size: isStep ? 10 : 12 }));
  }

  // L6 reach check: places nobody can get to (red), and places you can't get back from (orange)
  const reach = arenaReach(a);
  for (const [list, color, what] of [[reach.unreachable, '#e53935', "CAN'T REACH"], [reach.traps, '#fb8c00', 'NO WAY BACK']] as const) {
    for (const s of list) {
      out.push(`<rect x="${px(s.x0)}" y="${px(s.y) - 5}" width="${px(s.x1 - s.x0)}" height="5" fill="${color}"/>`);
      out.push(text(px((s.x0 + s.x1) / 2), px(s.y) - 9, what, { bold: true, size: 11, color }));
    }
  }

  // crates
  for (const c of a.crates) {
    const h = c.size / 2;
    out.push(`<rect x="${px(c.x - h)}" y="${px(c.y - h)}" width="${px(c.size)}" height="${px(c.size)}" fill="${COLORS.crate}" stroke="#1b1b1b" stroke-width="2"/>`);
    out.push(`<path d="M${px(c.x - h)} ${px(c.y - h)} L${px(c.x + h)} ${px(c.y + h)} M${px(c.x + h)} ${px(c.y - h)} L${px(c.x - h)} ${px(c.y + h)}" stroke="#1b1b1b" stroke-opacity="0.5"/>`);
  }
  // one "Crate" label per stack
  a.crates.forEach((c, i) => {
    if (a.crates.slice(0, i).some((o) => Math.abs(o.x - c.x) < 0.1)) return;
    const topY = Math.min(...a.crates.filter((o) => Math.abs(o.x - c.x) < 0.1).map((o) => o.y - o.size / 2));
    out.push(text(px(c.x), px(topY) - 6, 'Crate', { size: 11 }));
  });

  // other hazards
  for (const h of a.hazards) {
    if (h.kind === 'trampoline') {
      out.push(`<rect x="${px(h.x)}" y="${px(h.y) - 6}" width="${px(h.w)}" height="6" fill="#ff1744" stroke="#000"/>`);
      out.push(text(px(h.x + h.w / 2), px(h.y) - 12, 'Trampoline', { bold: true, size: 11, color: '#c62828' }));
    } else if (h.kind === 'conveyor') {
      out.push(`<rect x="${px(h.x)}" y="${px(h.y) - 5}" width="${px(h.w)}" height="5" fill="#37474f"/>`);
      const dir = Math.sign(h.speed) || 1;
      for (let x = h.x + 0.4; x < h.x + h.w; x += 0.6) out.push(`<path d="M${px(x)} ${px(h.y) - 4.5} l${dir * 5} 2 l${-dir * 5} 2" stroke="#ffd600" fill="none" stroke-width="1.5"/>`);
      out.push(text(px(h.x + h.w / 2), px(h.y) - 10, `Conveyor ${dir > 0 ? '→' : '←'}`, { bold: true, size: 11 }));
    } else if (h.kind === 'seesaw') {
      const half = h.length / 2;
      out.push(`<path d="M${px(h.x)} ${px(h.y)} l-8 ${px(0.6)} l16 0 Z" fill="#5d4037"/>`);
      out.push(`<rect x="${px(h.x - half)}" y="${px(h.y) - 6}" width="${px(h.length)}" height="6" fill="#8d6e63" stroke="#000"/>`);
      const name = h.label.startsWith('seesaw') ? 'Seesaw' : `${h.label[0].toUpperCase()}${h.label.slice(1).replace(/_/g, ' ')} (tips like a seesaw)`;
      out.push(text(px(h.x), px(h.y) - 26, name, { bold: true, size: 12 }));
    } else if (h.kind === 'wrecking_ball') {
      const by = h.y + h.length;
      out.push(`<circle cx="${px(h.x)}" cy="${px(h.y)}" r="4" fill="#424242"/>`);
      out.push(`<line x1="${px(h.x)}" y1="${px(h.y)}" x2="${px(h.x)}" y2="${px(by)}" stroke="#424242" stroke-width="3"/>`);
      out.push(`<path d="M${px(h.x - h.length * 0.6)} ${px(h.y + h.length * 0.8)} A ${px(h.length)} ${px(h.length)} 0 0 0 ${px(h.x + h.length * 0.6)} ${px(h.y + h.length * 0.8)}" fill="none" stroke="#90a4ae" stroke-dasharray="4 4"/>`);
      out.push(`<circle cx="${px(h.x)}" cy="${px(by)}" r="${px(h.radius)}" fill="#455a64" stroke="#000" stroke-width="2"/>`);
      out.push(text(px(h.x), px(h.y) - 8, 'Wrecking ball (shoot to swing)', { bold: true, size: 12 }));
    }
  }

  // apples, power-up bubbles, spawns
  for (const ap of a.apples) {
    out.push(`<circle cx="${px(ap.x)}" cy="${px(ap.y)}" r="7" fill="${ap.kind === 'red' ? '#ff3d3d' : '#ffc400'}" stroke="#1b1b1b" stroke-width="2"/>`);
    out.push(text(px(ap.x), px(ap.y) - 11, ap.kind === 'red' ? 'Apple +health' : 'Apple +stamina', { size: 10 }));
  }
  for (const p of a.pickups) {
    out.push(`<circle cx="${px(p.x)}" cy="${px(p.y)}" r="11" fill="#ffffff" fill-opacity="0.7" stroke="#1e88e5" stroke-width="2.5"/>`);
    out.push(text(px(p.x), px(p.y) + 4, '?', { bold: true, size: 13, color: '#1e88e5', halo: false }));
    out.push(text(px(p.x), px(p.y) - 16, 'Power-up bubble', { bold: true, size: 11, color: '#1565c0' }));
  }
  a.spawns.forEach((sp, i) => {
    const x = px(sp.x);
    const y = px(sp.y);
    out.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y - 22}" stroke="#2e7d32" stroke-width="2"/>`);
    out.push(`<path d="M${x} ${y - 22} l${sp.facing * 12} 5 l${-sp.facing * 12} 5 Z" fill="#43a047"/>`);
    out.push(text(x + sp.facing * 5, y - 25, `S${i + 1}`, { bold: true, size: 10, color: '#1b5e20' }));
  });

  // small size: only this part is used when few players
  if (def.narrow && size === 'full') {
    const x0 = px(def.narrow.from);
    const x1 = px(def.narrow.to);
    out.push(`<rect x="${x0}" y="1" width="${x1 - x0}" height="${H - 2}" fill="none" stroke="#6a1b9a" stroke-width="2.5" stroke-dasharray="10 6"/>`);
    out.push(text(x0 + 6, H - 8, `small size (few players): x ${def.narrow.from}-${def.narrow.to} only`, { anchor: 'start', size: 12, bold: true, color: '#6a1b9a' }));
  }
  out.push('</g>');
  const title =
    size === 'narrow'
      ? `${def.name}: SMALL SIZE (1-4 players)  ·  ${a.width} x ${a.height} m  ·  ${a.spawns.length} spawns`
      : `${def.name}${def.narrow ? ': FULL SIZE (5-8 players)' : ''}  ·  ${def.width} x ${def.height} m  ·  ${a.spawns.length} spawns`;
  out.push(text(0, 22, title, { anchor: 'start', size: 17, bold: true, halo: false }));
  out.push('</svg>');
  return out.join('\n');
}

const files = process.argv.slice(2);
const drafts = files.length > 0;
const defs: ArenaDef[] = [];
for (const f of files) {
  const mod = (await import(pathToFileURL(resolve(f)).href)) as Record<string, unknown>;
  for (const v of Object.values(mod)) if (v && typeof v === 'object' && 'solids' in v && 'spawns' in v) defs.push(v as ArenaDef);
}
if (!drafts) defs.push(...Object.values(ARENAS));

/** Every map to draw: drafts get both sizes (small first: it's the one being designed), with the validator's verdict. */
const maps: string[] = [];
for (const d of defs) {
  const sizes: ArenaSize[] = drafts && d.narrow ? ['narrow', 'full'] : ['full'];
  for (const size of sizes) {
    const layout = arenaLayout(d, size);
    const problems = validateArena(layout);
    const r = arenaReach(layout);
    const stumps = arenaReach(layout, 'stumps');
    const reachProblems = [
      ...r.unreachable.map((s) => `can't reach ${describeSurface(s)}`),
      ...r.traps.map((s) => `no way back from ${describeSurface(s)}`),
      ...r.blockedTrampolines.map((t) => `trampoline ${t.label} throws ${t.launch} m up into ${t.by} (${t.room} m above)`),
    ];
    console.log(`${d.id}/${size}: ${problems.length ? problems.join('; ') : 'valid'}; reach: ${reachProblems.length ? reachProblems.join('; ') : 'every place reachable'}`);
    const verdict =
      `<p class="${problems.length ? 'bad' : 'ok'}">Validator: ${problems.length ? problems.map(esc).join('<br>') : 'no problems'}</p>` +
      `<p class="${reachProblems.length ? 'bad' : 'ok'}">Reach (jumps ${esc(String(r.surfaces.length))} places): ${reachProblems.length ? reachProblems.map(esc).join('<br>') : 'every place can be reached and left'}` +
      `; on two stumps ${stumps.unreachable.length ? `out of reach: ${stumps.unreachable.map((s) => esc(s.labels[0])).join(', ')}` : 'everything in reach'}</p>`;
    maps.push(`<div class="map">${arenaSvg(d, size)}${verdict}</div>`);
  }
}
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Arena Maps</title>
<style>
  body { margin: 0; padding: 20px; background: #f5f7f6; color: #10262e; font: 14px system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p { margin: 0 0 18px; color: #4f6f63; }
  .map { background: #fff; border: 1px solid #d6dfdb; border-radius: 8px; padding: 14px; margin-bottom: 22px; overflow-x: auto; }
  svg { display: block; max-width: 100%; height: auto; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; }
  .ok { color: #2e7d32; margin: 8px 0 0; } .bad { color: #c62828; margin: 8px 0 0; }
  .legend span::before { content: ''; display: inline-block; width: 14px; height: 10px; margin-right: 6px; vertical-align: -1px; border: 1px solid #6d5a4b; background: var(--c); }
</style></head><body>
<h1>${drafts ? 'Arena drafts (not in the game yet)' : 'Arena maps (current)'}</h1>
<p>Drawn from the arena data files${drafts ? ` (${files.map(esc).join(', ')})` : ' (shared/src/arenas)'}. Regenerate: <code>npx tsx tools/arena-map.ts${drafts ? ` ${files.map(esc).join(' ')}` : ''}</code></p>
<div class="map legend">
  <span style="--c:${COLORS.ground}">Ground</span><span style="--c:${COLORS.solid}">Solid block / ledge</span>
  <span style="--c:${COLORS.ice}">Ice floor</span><span style="--c:${COLORS.bouncy}">Bouncy floor</span><span style="--c:${COLORS.pit}">Pit (kill zone)</span>
  <span style="--c:${COLORS.crate}">Crate (pushable)</span><span style="--c:#43a047">S1-S8 = spawn points (flag points the way they face)</span>
</div>
${maps.join('\n')}
<svg width="0" height="0"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#78909c"/></marker></defs></svg>
</body></html>`;
const outFile = drafts ? 'arena-drafts.html' : 'arena-maps.html';
writeFileSync(outFile, html);
console.log(`${outFile}: ${defs.map((d) => d.id).join(', ')}`);
