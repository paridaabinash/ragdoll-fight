// L7 preview: draws Frozen Lake's real data (shared/src/arenas/frozen-lake.ts) in the aurora look,
// with a few players, bullets and the clean HUD, so the idea can be judged before it goes into the game.
//   npx tsx tools/arena-drafts/frozen-lake-look.ts  ->  frozen-lake-look.html
import { writeFileSync } from 'node:fs';
import { arenaLayout, FROZEN_LAKE } from '../../shared/src';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const views = (['narrow', 'full'] as const).map((size) => {
  const a = arenaLayout(FROZEN_LAKE, size);
  return {
    size,
    width: a.width,
    height: a.height,
    solids: a.solids.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h, ice: s.surface === 'ice', label: s.label })),
    pits: (a.pits ?? []).map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })),
    crates: (a.crates ?? []).map((c) => ({ x: c.x, y: c.y, s: c.size })),
    apples: (a.apples ?? []).map((p) => ({ x: p.x, y: p.y, kind: p.kind })),
    pickups: a.pickups ?? [],
    spawns: a.spawns,
  };
});
const P = FROZEN_LAKE.palette!;
const data = JSON.stringify({ views, accent: hex(P.accent), terrain: hex(P.terrain) });

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frozen Lake Draft</title>
<style>
  :root { --bg: #05060a; --text: #d6dde2; --muted: #8a959d; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 1280px; margin: 0 auto; padding: 20px 16px 40px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 26px 0 8px; }
  p { margin: 4px 0; color: var(--muted); max-width: 900px; }
  canvas { width: 100%; height: auto; display: block; border-radius: 8px; }
  ul { color: var(--muted); margin: 6px 0; padding-left: 20px; } li { margin: 2px 0; }
</style></head><body><main>
<h1>Frozen Lake: the aurora arena (draft)</h1>
<p>Drawn from the draft's real data (tools/arena-drafts/frozen-lake.ts): every block, the hole, the apples and spawns are where the game would put them. Not in the game yet.</p>
<ul>
  <li><b>Middle:</b> a frozen lake (slippery ice, pale edges) with a 3 m hole in the centre. Jumpable, but falling in is a ring-out, and the ice makes you slide.</li>
  <li><b>Each side:</b> a snowy bank 1 m above the ice, a frozen rock as low cover out on the ice, a snow mound with pines, and an ice shelf hanging out over the lake (slippery sniper perch).</li>
  <li><b>Bait:</b> the health apple floats right over the hole; the power-up bubble above it.</li>
  <li><b>Big size (5-8 players):</b> snowfields outside, with a snow step up to a cliff on each side.</li>
  <li>Validator: both sizes valid; reach check: every place reachable.</li>
</ul>
<h2>Small size (1-4 players): the 40 m duel</h2>
<canvas id="narrow" width="1280" height="720"></canvas>
<h2>Full size (5-8 players)</h2>
<canvas id="full" width="1280" height="460"></canvas>
<script>
const D = ${data};
const PLAYERS = ['#00e5ff', '#ff2bd6', '#76ff03', '#ffea00'];
const rgba = (h, a) => { const n = parseInt(h.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; };
const darker = (h, k) => { const n = parseInt(h.slice(1), 16); const f = (v) => Math.round(v * k); return 'rgb(' + f(n >> 16) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')'; };

function draw(id, v) {
  const c = document.getElementById(id), g = c.getContext('2d');
  const W = c.width, H = c.height;
  const S = Math.min(W / v.width, H / v.height); // px per m
  const ox = (W - v.width * S) / 2, oy = H - v.height * S;
  const X = (x) => ox + x * S, Y = (y) => oy + y * S;
  // ---- aurora sky (detailed): curtains of fine vertical rays, a faint star band, pines and snowy peaks ----
  const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#050d10'); sky.addColorStop(0.55, '#06100f'); sky.addColorStop(1, '#030707');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  let s = 33; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  // a faint milky band of tiny stars, corner to corner
  for (let i = 0; i < 420; i++) { const t = rnd(), off = (rnd() - 0.5) * H * 0.16 * (1 + rnd());
    const x = t * W, y = H * 0.08 + t * H * 0.22 + off; g.fillStyle = 'rgba(200,215,230,' + (0.04 + rnd() * 0.09).toFixed(3) + ')'; g.fillRect(x, y, 1, 1); }
  for (let i = 0; i < 70; i++) { g.fillStyle = 'rgba(225,235,240,' + (0.1 + rnd() * 0.2).toFixed(2) + ')'; const z = rnd() < 0.15 ? 2 : 1.3; g.fillRect(rnd() * W, rnd() * H * 0.5, z, z); }
  // one aurora curtain: a folding line along x; from it, thin vertical rays rise (bright green at the foot, fading
  // to violet at the top), their heights rippling. Blurred a little, so it reads as light, never as lines.
  const curtain = (baseY, fold, ray, height, phase, a, blur) => {
    g.save(); g.filter = 'blur(' + blur + 'px)';
    for (let x = -20; x <= W + 20; x += ray) {
      const y = baseY + fold * Math.sin(x / (W / 3.2) + phase) + fold * 0.35 * Math.sin(x / (W / 11) + phase * 2);
      const h = height * (0.55 + 0.45 * Math.abs(Math.sin(x / (W / 7) + phase * 1.7))) * (0.8 + 0.4 * rnd());
      const grad = g.createLinearGradient(0, y, 0, y - h);
      grad.addColorStop(0, 'rgba(80,235,165,' + (a * (0.7 + 0.3 * rnd())).toFixed(3) + ')');
      grad.addColorStop(0.35, 'rgba(60,190,150,' + (a * 0.55).toFixed(3) + ')');
      grad.addColorStop(0.75, 'rgba(110,90,190,' + (a * 0.3).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(110,90,190,0)');
      g.fillStyle = grad; g.fillRect(x, y - h, ray * 0.85, h + 2);
    }
    g.restore();
  };
  curtain(H * 0.3, H * 0.07, 5, H * 0.22, 0.4, 0.16, 2.5);
  curtain(H * 0.2, H * 0.05, 6, H * 0.15, 2.3, 0.1, 3);
  curtain(H * 0.12, H * 0.035, 7, H * 0.1, 4.1, 0.06, 3.5);
  // the aurora's glow on the horizon and on the lake ice (a soft green wash)
  g.save(); g.translate(W / 2, Y(18)); g.scale(1, 0.18);
  const hz = g.createRadialGradient(0, 0, 0, 0, 0, W * 0.6); hz.addColorStop(0, 'rgba(60,190,140,0.11)'); hz.addColorStop(1, 'rgba(60,190,140,0)');
  g.fillStyle = hz; g.fillRect(-W, -W, 2 * W, 2 * W); g.restore();
  // snowy peaks (rock + a snow cap), then a dim pine forest along the horizon
  const peak = (px, py, w) => { const base = Y(17.2); g.fillStyle = '#081110'; g.beginPath(); g.moveTo(px - w, base); g.lineTo(px, py); g.lineTo(px + w, base); g.closePath(); g.fill();
    const k = 0.2; g.fillStyle = '#152120'; g.beginPath(); g.moveTo(px, py); g.lineTo(px + w * k, py + (base - py) * k); g.lineTo(px + w * k * 0.35, py + (base - py) * k * 0.8);
    g.lineTo(px - w * k * 0.15, py + (base - py) * k * 0.95); g.lineTo(px - w * k, py + (base - py) * k); g.closePath(); g.fill(); };
  peak(W * 0.05, H * 0.4, W * 0.2); peak(W * 0.2, H * 0.53, W * 0.14); peak(W * 0.33, H * 0.6, W * 0.1);
  peak(W * 0.95, H * 0.38, W * 0.2); peak(W * 0.8, H * 0.52, W * 0.14); peak(W * 0.67, H * 0.6, W * 0.1);
  g.fillStyle = '#060c0c';
  for (let x = 0; x < W; x += S * (0.5 + rnd() * 0.6)) { const h = S * (0.9 + rnd() * 1.4), base = Y(17.4);
    g.beginPath(); g.moveTo(x, base - h); g.lineTo(x + h * 0.32, base); g.lineTo(x - h * 0.32, base); g.closePath(); g.fill(); }
  g.fillRect(0, Y(17.4), W, H);
  // ---- the arena (the draft's data) ----
  for (const p of v.pits) { g.fillStyle = '#020404'; g.fillRect(X(p.x), Y(p.y - 1.2), p.w * S, (p.h + 1.2) * S); }
  for (const b of v.solids) {
    g.fillStyle = b.ice ? '#0c1716' : D.terrain; g.fillRect(X(b.x), Y(b.y), b.w * S, b.h * S);
    if (b.ice) { // ice: a pale edge, a faint sheen, and the aurora's green light reflected in streaks
      g.fillStyle = 'rgba(170,235,240,0.55)'; g.fillRect(X(b.x), Y(b.y), b.w * S, 2);
      g.fillStyle = 'rgba(170,235,240,0.06)'; g.fillRect(X(b.x), Y(b.y) + 2, b.w * S, Math.min(b.h * S, S * 0.6));
      for (let x = X(b.x) + 4; x < X(b.x + b.w) - 4; x += 7) { g.fillStyle = 'rgba(80,220,160,' + (0.03 + rnd() * 0.05).toFixed(3) + ')'; g.fillRect(x, Y(b.y) + 3, 3, S * (0.3 + rnd() * 0.5)); }
    } else {
      g.fillStyle = D.accent; g.globalAlpha = 0.6; g.fillRect(X(b.x), Y(b.y), b.w * S, 2); g.globalAlpha = 1;
      // snow: a pale crust and a few static sparkles on top
      g.fillStyle = 'rgba(200,225,230,0.07)'; g.fillRect(X(b.x), Y(b.y) + 2, b.w * S, Math.min(b.h * S, 5));
      for (let k = 0; k < b.w * 1.5; k++) { g.fillStyle = 'rgba(230,245,250,' + (0.15 + rnd() * 0.25).toFixed(2) + ')'; g.fillRect(X(b.x) + rnd() * b.w * S, Y(b.y) + 2 + rnd() * 5, 1.2, 1.2); }
    }
    if (b.label.startsWith('pine_ledge')) { // two dark pines on each snow mound
      for (const k of [0.25, 0.7]) { const px = X(b.x + b.w * k), py = Y(b.y); g.fillStyle = '#071010';
        g.beginPath(); g.moveTo(px, py - S * 2.2); g.lineTo(px + S * 0.6, py); g.lineTo(px - S * 0.6, py); g.closePath(); g.fill(); }
    }
  }
  for (const c of v.crates) { g.fillStyle = '#3b2c22'; g.fillRect(X(c.x - c.s / 2), Y(c.y - c.s / 2), c.s * S, c.s * S); g.strokeStyle = '#7a5c46'; g.lineWidth = 2; g.strokeRect(X(c.x - c.s / 2), Y(c.y - c.s / 2), c.s * S, c.s * S); }
  for (const a of v.apples) { g.fillStyle = a.kind === 'red' ? '#ff3355' : '#ffd400'; g.beginPath(); g.arc(X(a.x), Y(a.y), S * 0.35, 0, 7); g.fill(); }
  for (const p of v.pickups) { g.strokeStyle = 'rgba(128,216,255,0.9)'; g.lineWidth = 2; g.beginPath(); g.arc(X(p.x), Y(p.y), S * 0.5, 0, 7); g.stroke(); }
  // ---- players on the first spawns, guns, a couple of bullets ----
  const fig = (x, y, color, facing, aim) => {
    const k = S / 32, foot = Y(y), hip = foot - 19 * k * 1.6, neck = foot - 35 * k * 1.6, head = foot - 44 * k * 1.6, cx = X(x);
    g.lineCap = 'round'; g.lineWidth = 4.5 * k * 1.4;
    const seg = (pts, col) => { g.strokeStyle = col; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); g.stroke(); };
    seg([[cx, hip], [cx - 7 * k * facing, (hip + foot) / 2], [cx - 5 * k * facing, foot]], darker(color, 0.65));
    seg([[cx, neck + 5 * k], [cx - 9 * k * facing, hip - 2 * k]], darker(color, 0.65));
    seg([[cx, neck], [cx, hip]], color);
    seg([[cx, hip], [cx + 7 * k * facing, (hip + foot) / 2], [cx + 4 * k * facing, foot]], color);
    const hx = cx + Math.cos(aim) * 22 * k, hy = neck + 4 * k + Math.sin(aim) * 22 * k;
    seg([[cx, neck + 4 * k], [hx, hy]], color);
    g.save(); g.translate(hx, hy); g.rotate(aim); g.fillStyle = '#c9cfdc'; g.fillRect(-3 * k, -3 * k, 26 * k, 6 * k); g.restore();
    g.fillStyle = color; g.beginPath(); g.arc(cx, head, 8 * k * 1.3, 0, 7); g.fill();
    return { x: cx, top: head - 14 * k };
  };
  const sp = v.spawns;
  const me = fig(sp[0].x + 0.4, sp[0].y, PLAYERS[0], 1, -0.12);
  fig(sp[1].x, sp[1].y, PLAYERS[1], -1, Math.PI + 0.15);
  fig(sp[4].x + 0.6, sp[4].y, PLAYERS[2], 1, 0.35);
  fig(sp[3].x, sp[3].y, PLAYERS[3], -1, Math.PI - 0.2);
  const bullet = (x, y, ang, col) => { const L = S * 1.6; g.strokeStyle = rgba(col, 0.35); g.lineWidth = 3; g.beginPath(); g.moveTo(x - Math.cos(ang) * L, y - Math.sin(ang) * L); g.lineTo(x, y); g.stroke();
    g.strokeStyle = '#fff59d'; g.beginPath(); g.moveTo(x - Math.cos(ang) * S * 0.4, y - Math.sin(ang) * S * 0.4); g.lineTo(x, y); g.stroke(); };
  bullet(X(v.width * 0.42), Y(15.2), -0.05, PLAYERS[0]); bullet(X(v.width * 0.62), Y(13.3), Math.PI + 0.25, PLAYERS[1]);
  // ---- clean HUD: YOU over me, the players panel, the clock ----
  g.font = '700 ' + Math.round(13 * Math.max(1, S / 32)) + 'px system-ui'; g.textAlign = 'center'; g.fillStyle = PLAYERS[0]; g.fillText('YOU', me.x, me.top - 6); g.fillText('▼', me.x, me.top + 6);
  g.fillStyle = 'rgba(5,7,11,0.55)'; g.fillRect(8, 8, 200, 16 + 4 * 20);
  ['tester (you)', 'Wobbles', 'Noodle', 'Bonk'].forEach((n, i) => { const y = 26 + i * 20; g.fillStyle = PLAYERS[i]; g.beginPath(); g.arc(20, y - 4, 5, 0, 7); g.fill(); g.textAlign = 'left'; g.font = (i ? '' : '700 ') + '13px monospace'; g.fillStyle = i ? '#c9d1d9' : '#fff'; g.fillText(n, 32, y); g.textAlign = 'right'; g.fillText(String([4, 6, 2, 3][i]), 198, y); });
  g.textAlign = 'center'; g.font = '14px monospace'; g.fillStyle = 'rgba(227,233,238,0.73)'; g.fillText('Frozen Lake · 2:31 · first to 15', W / 2, 22);
}
draw('narrow', D.views[0]);
draw('full', D.views[1]);
</script></main></body></html>`;

writeFileSync('frozen-lake-look.html', html);
console.log('frozen-lake-look.html');
