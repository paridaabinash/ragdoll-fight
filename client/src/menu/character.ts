import Phaser from 'phaser';
import { GameWorld, GUN, PART_NAMES, PX_PER_M, type Controls, type HatKind, type Logger, type Vec2 } from '@ragdoll/shared';
import { DustTracker, feetOf, solesOf } from '../dust';
import { HitFx } from '../fx';
import { drawBullet, readyShare } from '../gun-draw';
import { CartoonSmoke } from '../smoke';
import { colorOfSlot, drawBody, LandingSquash } from '../skin';
import { quietLogger } from './quiet-log';

const ID = 'me';
/**
 * The little stage (m): floor top, where the stickman starts, how much of it the card shows (height; the width follows
 * the card), the invisible walls' thickness. Walls sit exactly at the card's edges and a lid above, so it can't leave.
 */
const STAGE = { floorY: 6, x: 5, viewH: 3.6, wall: 0.5 } as const;

/** Keys as in the game (`PlayerInput.read`): A/D or arrows walk, W/Up/Space jump, S/Down crouch. */
const KEY = {
  left: ['a', 'arrowleft'],
  right: ['d', 'arrowright'],
  jump: ['w', 'arrowup', ' '],
  crouch: ['s', 'arrowdown'],
} as const;

/**
 * M4 character card: your stickman, live, wearing the hat you picked, in its own tiny world (separate from any game).
 * It plays like the game: the gun follows the mouse (anywhere on the page), a click (or hold) on the card fires a real
 * shot, A/D or arrows walk, W/Up/Space jump, S/Down crouch, with the same legs and the same cartoon smoke. Keys are
 * ignored while you type in a box or a button has focus.
 */
class PreviewScene extends Phaser.Scene {
  private world!: GameWorld;
  private gfx!: Phaser.GameObjects.Graphics;
  private readonly squash = new LandingSquash();
  private readonly dust = new DustTracker();
  private smoke!: CartoonSmoke;
  private hitFx!: HitFx;
  private acc = 0;
  private last = 0;
  hat: HatKind = 'none';
  /** Half the width the card shows (m): the walls' inner faces. */
  private halfW = 0;
  /** Where the mouse is (page coordinates), keys held, quick taps since the last frame, the trigger held. */
  private mouse: { x: number; y: number } | null = null;
  private readonly held = new Set<string>();
  private tapped = { jump: false, crouch: false };
  private trigger = false;
  private shots = 0;
  private readonly off: (() => void)[] = [];

  constructor(private readonly log: Logger) {
    super('preview');
  }

  create(): void {
    // (the card's own world logs only its warnings: its walks and jumps aren't a game)
    this.world = new GameWorld(quietLogger('menu_card', this.log));
    const zoom = this.scale.height / (STAGE.viewH * PX_PER_M);
    this.halfW = this.scale.width / zoom / PX_PER_M / 2;
    const top = STAGE.floorY - STAGE.viewH - 1;
    this.world.addBox('floor', 'fixed', { x: STAGE.x, y: STAGE.floorY + 0.5 }, { x: this.halfW + STAGE.wall, y: 0.5 });
    for (const side of [-1, 1]) this.world.addBox(`wall_${side}`, 'fixed', { x: STAGE.x + side * (this.halfW + STAGE.wall / 2), y: (top + STAGE.floorY) / 2 }, { x: STAGE.wall / 2, y: (STAGE.floorY - top) / 2 });
    this.world.addBox('lid', 'fixed', { x: STAGE.x, y: top - 0.25 }, { x: this.halfW + STAGE.wall, y: 0.25 });
    this.world.addPlayer(ID, { x: STAGE.x, y: STAGE.floorY }, 1);
    this.gfx = this.add.graphics();
    this.smoke = new CartoonSmoke(this, this.log);
    this.hitFx = new HitFx(this, this.log);
    const cam = this.cameras.main;
    cam.setZoom(zoom);
    cam.centerOn(STAGE.x * PX_PER_M, (STAGE.floorY - STAGE.viewH / 2 + 0.35) * PX_PER_M);
    // a click (or hold) on the card fires; the mouse anywhere on the page aims; the keys anywhere move
    this.input.on('pointerdown', () => (this.trigger = true));
    this.listen(window, 'pointerup', () => (this.trigger = false));
    this.listen(window, 'pointermove', (e) => (this.mouse = { x: (e as PointerEvent).clientX, y: (e as PointerEvent).clientY }));
    this.listen(window, 'keydown', (e) => this.key(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.key(e as KeyboardEvent, false));
    this.listen(window, 'blur', () => this.held.clear());
    this.events.once('destroy', () => this.off.forEach((f) => f()));
    if (import.meta.env.DEV) (window as unknown as { preview: PreviewScene }).preview = this; // for inspecting from devtools
  }

  private listen(target: Window, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.off.push(() => target.removeEventListener(type, fn));
  }

  /** A key for the stickman, unless you're typing in a box or a button has focus (Space would press it). */
  private key(e: KeyboardEvent, down: boolean): void {
    const k = e.key.toLowerCase();
    if (!Object.values(KEY).some((list) => (list as readonly string[]).includes(k))) return;
    // (an element with focus other than the page itself or a canvas: a box being typed in, a button)
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (down && el && el !== document.body && el.tagName !== 'CANVAS') return;
    if (down) {
      e.preventDefault(); // (arrows and Space would scroll the page)
      if (!this.held.has(k)) {
        if ((KEY.jump as readonly string[]).includes(k)) this.tapped.jump = true;
        if ((KEY.crouch as readonly string[]).includes(k)) this.tapped.crouch = true;
      }
      this.held.add(k);
    } else this.held.delete(k);
  }

  private any(list: readonly string[]): boolean {
    return list.some((k) => this.held.has(k));
  }

  /** The gun's angle toward the mouse (page coordinates -> this card's world), or null before the mouse moved. */
  private aimAngle(): number | null {
    if (!this.mouse) return null;
    const r = this.game.canvas.getBoundingClientRect();
    const sx = ((this.mouse.x - r.left) / r.width) * this.scale.width;
    const sy = ((this.mouse.y - r.top) / r.height) * this.scale.height;
    const w = this.cameras.main.getWorldPoint(sx, sy);
    const s = this.world.player(ID).jointPos('shoulderFront');
    return Math.atan2(w.y / PX_PER_M - s.y, w.x / PX_PER_M - s.x);
  }

  private controls(aim: number | null): Controls {
    const left = this.any(KEY.left);
    const right = this.any(KEY.right);
    const c: Controls = {
      aim: aim === null ? null : { angle: aim },
      crouch: this.tapped.crouch || this.any(KEY.crouch),
      jump: this.tapped.jump || this.any(KEY.jump),
      move: left === right ? 0 : left ? -1 : 1,
      taunt: false,
    };
    this.tapped = { jump: false, crouch: false };
    return c;
  }

  update(time: number): void {
    const dt = this.last ? Math.min(250, time - this.last) : 0;
    this.last = time;
    this.acc += dt / 1000;
    const aim = this.aimAngle();
    this.world.setControls(ID, this.controls(aim));
    for (let i = 0; i < 4 && this.acc >= 1 / 60; i++) {
      // held = fire on every reload, like the game (the world refuses a shot that's too soon, so ask only when ready)
      const st = this.world.playerStats(ID);
      if (this.trigger && aim !== null && st.fireBlock(this.world.tick) === null && this.world.fire(ID, { angle: aim }).arrow) {
        this.shots++;
        if (this.shots === 1 || this.shots % 20 === 0) this.log.info('menu_fire', { shots: this.shots });
      }
      this.world.step();
      this.acc -= 1 / 60;
    }
    if (this.acc > 1 / 60) this.acc = 0;
    const p = this.world.player(ID);
    // (the walls make this impossible; if it ever happens, it's logged and the body is put back)
    if (Math.abs(p.center().x - STAGE.x) > this.halfW + 0.5 || p.center().y > STAGE.floorY + 1) {
      this.log.warn('preview_left_stage', { at: { x: Math.round(p.center().x * 100) / 100, y: Math.round(p.center().y * 100) / 100 }, halfW: this.halfW });
      this.world.relocate(ID, { x: STAGE.x, y: STAGE.floorY }, 1);
    }
    for (const ev of this.world.takeEvents()) {
      if (ev.type === 'impact') {
        this.hitFx.spark(ev.pos);
        this.hitFx.puff(ev.pos, 0x8a959d, 0.35, Math.cos(ev.angle) > 0 ? -1 : 1);
      }
    }
    const g = this.gfx.clear();
    g.fillStyle(0xffffff, 0.08).fillEllipse(p.center().x * PX_PER_M, STAGE.floorY * PX_PER_M, 2.2 * PX_PER_M, 0.25 * PX_PER_M);
    const parts = PART_NAMES.map((n) => ({ ...p.parts[n].translation(), a: p.parts[n].rotation() }));
    const st = this.world.playerStats(ID);
    const squash = this.squash.update(ID, p.grounded, this.world.tick, time);
    drawBody(g, { parts, squash, facing: p.facing, alive: st.alive, color: colorOfSlot(1), headScale: 1, hat: this.hat, gun: { ready: readyShare(st.reloadLeft(this.world.tick), GUN.reloadTicks), special: null } });
    for (const a of this.world.arrows) if (a.state === 'flying') drawBullet(g, a.pos as Vec2, a.angle, colorOfSlot(1));
    for (const d of this.dust.update([{ id: ID, feet: feetOf(parts), soles: solesOf(parts), grounded: p.grounded, alive: st.alive }], time)) this.smoke.puff(d);
    this.smoke.update(dt / 1000, g);
    this.hitFx.draw(g, Math.min(dt, 100) / 1000);
  }
}

/** The character card on the home page: a small canvas inside `parent`. `destroy()` when the game starts. */
export class CharacterPreview {
  private readonly game: Phaser.Game;
  private readonly scene: PreviewScene;

  constructor(parent: HTMLElement, log: Logger, hat: HatKind) {
    this.scene = new PreviewScene(log);
    this.scene.hat = hat;
    // as wide as the card (more room to walk), within reason
    const width = Math.round(Math.max(240, Math.min(420, parent.clientWidth || 240)));
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width,
      height: 260,
      transparent: true,
      scene: this.scene,
      banner: false,
      audio: { noAudio: true },
      // (the card reads the keys itself, so typing in the name box is never eaten)
      input: { keyboard: false },
    });
  }

  setHat(hat: HatKind): void {
    this.scene.hat = hat;
  }

  destroy(): void {
    this.game.destroy(true);
  }
}
