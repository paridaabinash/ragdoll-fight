import Phaser from 'phaser';
import {
  arenaById,
  arenaInfo,
  arenaLayout,
  buildArena,
  GameWorld,
  GUN,
  HATS,
  launchPointFrom,
  PART_NAMES,
  PX_PER_M,
  ROTATION,
  solveAim,
  type ArenaLayout,
  type HatKind,
  type Logger,
  type Vec2,
} from '@ragdoll/shared';
import { colorOfSlot, drawBody, drawHazards, drawMovable, drawStatic, FlyingHats, SCENE } from '../skin';
import { drawBullet } from '../gun-draw';
import { paintSky } from './arena-thumb';
import './menu.css';

/**
 * M5 portal cover art (`?mode=cover`): a staged hero moment played by the real game (real arena, real ragdolls, a real
 * shot through `GameWorld.fire`), framed for each portal size, with the logo on top. "Save PNG" downloads it.
 * CrazyGames wants 1920x1080, 800x1200 and 800x800; Poki's tile is square (its upload form gives the final size).
 */
export const COVER_SIZES = {
  wide: { w: 1920, h: 1080, label: 'CrazyGames landscape 1920x1080' },
  tall: { w: 800, h: 1200, label: 'CrazyGames portrait 800x1200' },
  square: { w: 800, h: 800, label: 'CrazyGames square 800x800' },
  poki: { w: 1080, h: 1080, label: 'Poki square 1080x1080' },
} as const;
type CoverSize = keyof typeof COVER_SIZES;

interface CoverOptions {
  size: CoverSize;
  arena: string;
  /** Ticks after the hit (how far the victim has flown). */
  moment: number;
  /** Extra shove on the victim at the hit (m/s), for drama. 0 = just the game's own hit reaction. */
  kick: number;
  hat: HatKind;
  logo: boolean;
  /** How far apart the two players stand (m). */
  gap: number;
}

const DEFAULTS: CoverOptions = { size: 'wide', arena: 'windy_rooftop', moment: 20, kick: 9, hat: 'tophat', logo: true, gap: 7 };
const HERO = 'hero';
const VICTIM = 'victim';

class CoverScene extends Phaser.Scene {
  constructor(
    private readonly log: Logger,
    private readonly opts: CoverOptions,
  ) {
    super('cover');
  }

  create(): void {
    const { w, h } = COVER_SIZES[this.opts.size];
    const def = arenaById(this.opts.arena) ?? ROTATION[0];
    const layout = arenaLayout(def, 'full');
    const pal = arenaInfo(layout).palette;
    // the sky, painted to this exact canvas (fixed on screen)
    const key = `cover-sky:${def.id}:${w}x${h}`;
    if (!this.textures.exists(key)) {
      const tex = this.textures.createCanvas(key, w, h)!;
      paintSky(tex.context, pal, w, h);
      tex.refresh();
    }
    // Three cameras: the sky and the logo at zoom 1, the world zoomed in between (a camera's zoom would also scale
    // screen-fixed things, pushing the logo off the cover)
    const sky = this.add.image(0, 0, key).setOrigin(0).setScrollFactor(0);

    const shot = this.stage(layout);
    const g = this.add.graphics();
    const world = shot.world;
    const surfaces = new Map(layout.solids.filter((x) => x.surface).map((x) => [x.label, x.surface!]));
    for (const s of world.staticShapes()) drawStatic(g, s, pal, surfaces.get(s.label));
    drawHazards(g, layout.hazards, 0, (label) => {
      const b = world.bodyByLabel(label);
      return b ? { ...b.translation() } : null;
    });
    for (const m of world.movableBodies()) if (m.kind !== 'bubble' && m.collider.isEnabled()) drawMovable(g, m.label, m.shape, { ...m.body.translation(), a: m.body.rotation() });
    // the shot: a glowing streak from the muzzle to the hit, a burst where it hit
    if (shot.from && shot.hit) {
      const [a, b] = [shot.from, shot.hit];
      g.lineStyle(10, 0xfff59d, 0.15).lineBetween(a.x * PX_PER_M, a.y * PX_PER_M, b.x * PX_PER_M, b.y * PX_PER_M);
      g.lineStyle(3, 0xfff59d, 0.9).lineBetween(a.x * PX_PER_M, a.y * PX_PER_M, b.x * PX_PER_M, b.y * PX_PER_M);
      drawBullet(g, b, Math.atan2(b.y - a.y, b.x - a.x), colorOfSlot(1));
      for (let i = 0; i < 10; i++) {
        const t = (i / 10) * Math.PI * 2;
        const r1 = 0.15;
        const r2 = 0.45 + (i % 2) * 0.25;
        g.lineStyle(4, i % 2 ? 0xffea00 : 0xffffff, 0.95).lineBetween((b.x + Math.cos(t) * r1) * PX_PER_M, (b.y + Math.sin(t) * r1) * PX_PER_M, (b.x + Math.cos(t) * r2) * PX_PER_M, (b.y + Math.sin(t) * r2) * PX_PER_M);
      }
    }
    for (const id of [HERO, VICTIM]) {
      const p = world.player(id);
      const parts = PART_NAMES.map((n) => ({ ...p.parts[n].translation(), a: p.parts[n].rotation() }));
      drawBody(g, { parts, facing: p.facing, alive: true, color: colorOfSlot(id === HERO ? 1 : 2), headScale: 1, hat: id === HERO ? this.opts.hat : 'none', gun: { ready: id === HERO ? 0.2 : 1, special: null } });
    }
    shot.hats.draw(g, 0);

    // frame the two of them: the pair takes about half the width (more on a tall cover), a little above center
    const hero = world.player(HERO).center();
    const victim = world.player(VICTIM).center();
    const mid = { x: (hero.x + victim.x) / 2, y: Math.min(hero.y, victim.y) - 0.6 };
    const span = Math.abs(victim.x - hero.x) + 3.5;
    const share = w > h ? 0.62 : 0.9;
    const zoom = (w * share) / (span * PX_PER_M);
    this.cameras.main.setBackgroundColor(pal.sky.bottom).ignore(g);
    const cam = this.cameras.add(0, 0, w, h);
    cam.setZoom(zoom);
    cam.centerOn(mid.x * PX_PER_M, (mid.y + (w > h ? 0.9 : -0.8)) * PX_PER_M);
    cam.ignore(sky);
    const logo = this.opts.logo ? this.drawLogo(w, h) : [];
    if (logo.length) {
      this.cameras.main.ignore(logo);
      cam.ignore(logo);
      this.cameras.add(0, 0, w, h).ignore([sky, g]);
    }
    this.log.info('cover_built', { ...this.opts, w, h, hit: shot.hit ? [Math.round(shot.hit.x * 100) / 100, Math.round(shot.hit.y * 100) / 100] : null, zone: shot.zone });
  }

  /**
   * Plays the moment: hero and victim face each other on the same floor, the hero fires at the victim's head with the
   * real gun, and the world runs on `moment` ticks past the hit.
   */
  private stage(layout: ArenaLayout): { world: GameWorld; from: Vec2 | null; hit: Vec2 | null; zone: string | null; hats: FlyingHats } {
    const world = new GameWorld(this.log);
    buildArena(world, layout, { pickups: false });
    // two spawn points on one floor about `gap` apart (else the first two)
    const sp = layout.spawns;
    let pair: [typeof sp[number], typeof sp[number]] = [sp[0], sp[1]];
    let best = Infinity;
    for (const a of sp) for (const b of sp) {
      if (a === b || Math.abs(a.y - b.y) > 0.01 || b.x <= a.x) continue;
      const off = Math.abs(b.x - a.x - this.opts.gap);
      if (off < best) [best, pair] = [off, [a, b]];
    }
    world.addPlayer(HERO, { x: pair[0].x, y: pair[0].y }, 1);
    world.addPlayer(VICTIM, { x: pair[1].x, y: pair[1].y }, -1);
    const aimAtHead = () => {
      const s = world.player(HERO).jointPos('shoulderFront');
      const head = world.player(VICTIM).parts.head.translation();
      const a = solveAim(s, head, GUN.bulletSpeed);
      return a === null ? 0 : (solveAim(launchPointFrom(s, { angle: a }), head, GUN.bulletSpeed) ?? a);
    };
    for (let i = 0; i < 90; i++) {
      world.setControls(HERO, { aim: { angle: aimAtHead() }, crouch: false, jump: false, move: 0, taunt: false });
      world.step();
    }
    world.takeEvents();
    const fired = world.fire(HERO, { angle: aimAtHead() });
    const from = fired.arrow ? { ...fired.arrow.pos } : null;
    const hats = new FlyingHats();
    let hit: Vec2 | null = null;
    let zone: string | null = null;
    for (let i = 0; i < 120 && !hit; i++) {
      world.step();
      for (const ev of world.takeEvents()) {
        if (ev.type !== 'damage' || ev.id !== VICTIM) continue;
        hit = ev.pos;
        zone = ev.zone;
        const v = world.player(VICTIM);
        for (const part of v.attached()) world.push(part, { x: this.opts.kick * part.mass(), y: -this.opts.kick * 0.55 * part.mass() });
        hats.add(this.opts.hat === 'none' ? 'party' : this.opts.hat === 'tophat' ? 'party' : 'tophat', v.parts.head.translation(), ev.pos, v.facing);
      }
    }
    const scratch = this.add.graphics().setVisible(false);
    for (let i = 0; i < this.opts.moment; i++) {
      world.step();
      hats.draw(scratch.clear(), 1 / 60);
    }
    scratch.destroy();
    if (!hit) this.log.warn('cover_missed', { from, arena: layout.id });
    return { world, from, hit, zone, hats };
  }

  private drawLogo(w: number, h: number): Phaser.GameObjects.Text[] {
    const wide = w > h;
    const size = Math.round((wide ? h * 0.15 : w * 0.17) * (h > w ? 1.05 : 1));
    const x = wide ? w * 0.05 : w / 2;
    const y = wide ? h * 0.07 : h * 0.05;
    const style = (color: string, px: number, stroke: string): Phaser.Types.GameObjects.Text.TextStyle => ({ fontFamily: 'system-ui, sans-serif', fontStyle: 'italic 900', fontSize: `${px}px`, color, stroke, strokeThickness: Math.round(px * 0.12) });
    const top = this.add.text(x, y, 'RAGDOLL', style('#00e5ff', size, '#04363d')).setScrollFactor(0).setOrigin(wide ? 0 : 0.5, 0).setAngle(-3).setShadow(0, 0, 'rgba(0,229,255,0.6)', 24, false, true);
    const bottom = this.add.text(x + (wide ? size * 0.35 : 0), y + top.height * 0.82, 'ARCHERS', style('#ff2bd6', Math.round(size * 0.68), '#4a0b3f')).setScrollFactor(0).setOrigin(wide ? 0 : 0.5, 0).setAngle(-3).setShadow(0, 0, 'rgba(255,43,214,0.6)', 20, false, true);
    return [top, bottom];
  }
}

/** `?mode=cover`: the controls bar and the cover canvas. */
export function startCoverArt(log: Logger): void {
  let opts: CoverOptions = { ...DEFAULTS };
  let game: Phaser.Game | null = null;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:10;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 12px;background:rgba(12,15,22,.94);border-bottom:1px solid rgba(255,255,255,.15);font:13px system-ui;color:#eceff1';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:56px 0 0 0;display:flex;align-items:center;justify-content:center;';
  document.body.append(bar, host);
  document.body.style.overflow = 'auto';

  const select = (label: string, values: [string, string][], get: () => string, set: (v: string) => void) => {
    const l = document.createElement('label');
    l.textContent = `${label} `;
    const s = document.createElement('select');
    s.style.cssText = 'width:auto;padding:4px 6px;font-size:13px';
    for (const [v, t] of values) s.append(new Option(t, v, false, v === get()));
    s.onchange = () => (set(s.value), render());
    l.append(s);
    return l;
  };
  const range = (label: string, min: number, max: number, get: () => number, set: (v: number) => void) => {
    const l = document.createElement('label');
    const r = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), value: String(get()) });
    r.style.cssText = 'width:110px;vertical-align:middle';
    const out = document.createElement('b');
    out.textContent = String(get());
    r.onchange = () => (set(Number(r.value)), (out.textContent = r.value), render());
    l.append(`${label} `, r, ' ', out);
    return l;
  };
  const logo = Object.assign(document.createElement('input'), { type: 'checkbox', checked: opts.logo });
  logo.onchange = () => ((opts = { ...opts, logo: logo.checked }), render());
  const logoLabel = document.createElement('label');
  logoLabel.append(logo, ' logo');
  const save = Object.assign(document.createElement('button'), { textContent: 'Save PNG', className: 'btn-small' });
  save.onclick = () => {
    if (!game) return;
    const { w, h } = COVER_SIZES[opts.size];
    game.renderer.snapshot((img) => {
      const a = document.createElement('a');
      a.href = (img as HTMLImageElement).src;
      a.download = `cover-${opts.size}-${w}x${h}.png`;
      a.click();
      log.info('cover_saved', { size: opts.size, w, h, arena: opts.arena });
    });
  };
  bar.append(
    select('Size', Object.entries(COVER_SIZES).map(([k, v]) => [k, v.label]), () => opts.size, (v) => (opts = { ...opts, size: v as CoverSize })),
    select('Arena', ROTATION.map((a) => [a.id, a.name]), () => opts.arena, (v) => (opts = { ...opts, arena: v })),
    select('Hero hat', HATS.map((x) => [x.kind, x.name]), () => opts.hat, (v) => (opts = { ...opts, hat: v as HatKind })),
    range('Moment', 0, 40, () => opts.moment, (v) => (opts = { ...opts, moment: v })),
    range('Kick', 0, 14, () => opts.kick, (v) => (opts = { ...opts, kick: v })),
    range('Gap', 4, 12, () => opts.gap, (v) => (opts = { ...opts, gap: v })),
    logoLabel,
    save,
  );

  function render(): void {
    game?.destroy(true);
    const { w, h } = COVER_SIZES[opts.size];
    game = new Phaser.Game({
      type: Phaser.CANVAS,
      parent: host,
      width: w,
      height: h,
      backgroundColor: SCENE.background,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: w, height: h },
      banner: false,
      audio: { noAudio: true },
      scene: new CoverScene(log, opts),
    });
  }
  render();
}
