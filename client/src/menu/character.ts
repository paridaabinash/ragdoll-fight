import Phaser from 'phaser';
import { GameWorld, PART_NAMES, PX_PER_M, type HatKind, type Logger } from '@ragdoll/shared';
import { colorOfSlot, drawBody, LandingSquash } from '../skin';

const ID = 'me';
/**
 * The little stage (m): floor top, where the ragdoll stands, how much of it the card shows (height; the width follows
 * the card), the poke (m/s sideways and up). The first poke (2.6 / 1.6) threw the body clean off the card for 3 s:
 * now invisible walls sit at the card's edges and the poke is a shove, not a launch.
 */
const STAGE = { floorY: 6, x: 5, viewH: 3.6, pokePush: 1.5, pokeLift: 0.9, wall: 0.5 } as const;
/** After a poke settles (ms), the ragdoll walks back to the middle if it ended up more than `homeOff` m away. */
const HOME = { afterMs: 1200, off: 0.45 } as const;

/**
 * M4 character card: your ragdoll, live, wearing the hat you picked. It turns its gun toward the mouse, and a click
 * pokes it (a real push on the real ragdoll: it flops and gets back up). Its own tiny world, separate from any game.
 */
class PreviewScene extends Phaser.Scene {
  private world!: GameWorld;
  private gfx!: Phaser.GameObjects.Graphics;
  private readonly squash = new LandingSquash();
  private acc = 0;
  private last = 0;
  hat: HatKind = 'none';
  pokes = 0;
  /** Since the last poke: the farthest any body part got from the middle (m), for the log. */
  private farthest = 0;
  /** Half the width the card shows (m): the walls' inner faces. */
  private halfW = 0;
  /** Where the gun points (toward the mouse), and when the last poke was (it walks home after). */
  private aim: number | null = null;
  private pokedAt = -Infinity;

  constructor(private readonly log: Logger) {
    super('preview');
  }

  create(): void {
    this.world = new GameWorld(this.log);
    const zoom = this.scale.height / (STAGE.viewH * PX_PER_M);
    this.halfW = this.scale.width / zoom / PX_PER_M / 2;
    const top = STAGE.floorY - STAGE.viewH - 1;
    // floor, two walls at the card's edges and a lid: the ragdoll stays on the card whatever you do to it
    this.world.addBox('floor', 'fixed', { x: STAGE.x, y: STAGE.floorY + 0.5 }, { x: this.halfW + STAGE.wall, y: 0.5 });
    for (const side of [-1, 1]) this.world.addBox(`wall_${side}`, 'fixed', { x: STAGE.x + side * (this.halfW + STAGE.wall / 2), y: (top + STAGE.floorY) / 2 }, { x: STAGE.wall / 2, y: (STAGE.floorY - top) / 2 });
    this.world.addBox('lid', 'fixed', { x: STAGE.x, y: top - 0.25 }, { x: this.halfW + STAGE.wall, y: 0.25 });
    this.world.addPlayer(ID, { x: STAGE.x, y: STAGE.floorY }, 1);
    this.gfx = this.add.graphics();
    const cam = this.cameras.main;
    cam.setZoom(zoom);
    cam.centerOn(STAGE.x * PX_PER_M, (STAGE.floorY - STAGE.viewH / 2 + 0.35) * PX_PER_M);
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.aimAt(p));
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.poke(p));
    this.input.on('pointerout', () => (this.aim = null));
  }

  private worldPoint(p: Phaser.Input.Pointer): { x: number; y: number } {
    const w = this.cameras.main.getWorldPoint(p.x, p.y);
    return { x: w.x / PX_PER_M, y: w.y / PX_PER_M };
  }

  /** The gun follows the mouse: the ragdoll looks at you. */
  private aimAt(p: Phaser.Input.Pointer): void {
    const at = this.worldPoint(p);
    const s = this.world.player(ID).jointPos('shoulderFront');
    this.aim = Math.atan2(at.y - s.y, at.x - s.x);
  }

  /** A poke: pushed away from where you clicked, a little up. */
  private poke(p: Phaser.Input.Pointer): void {
    const at = this.worldPoint(p);
    const body = this.world.player(ID);
    const c = body.center();
    const dir = Math.sign(c.x - at.x) || 1;
    for (const part of body.attached()) this.world.push(part, { x: dir * STAGE.pokePush * part.mass(), y: -STAGE.pokeLift * part.mass() });
    this.pokes++;
    this.pokedAt = performance.now();
    // (how far the last poke threw it: inside the walls means it never left the card)
    if (this.pokes <= 3 || this.pokes % 10 === 0) this.log.info('menu_poke', { pokes: this.pokes, lastFarthest: Math.round(this.farthest * 100) / 100, halfW: Math.round(this.halfW * 100) / 100 });
    this.farthest = 0;
  }

  update(time: number): void {
    const dt = this.last ? Math.min(250, time - this.last) : 0;
    this.last = time;
    this.acc += dt / 1000;
    // a while after the last poke, walk back to the middle of the card (on its feet only)
    const body = this.world.player(ID);
    const off = body.center().x - STAGE.x;
    const home = performance.now() - this.pokedAt > HOME.afterMs && body.grounded && !body.down && Math.abs(off) > HOME.off;
    this.world.setControls(ID, { aim: this.aim === null ? null : { angle: this.aim }, crouch: false, jump: false, move: home ? (off > 0 ? -1 : 1) : 0, taunt: false });
    for (let i = 0; i < 4 && this.acc >= 1 / 60; i++) {
      this.world.step();
      this.acc -= 1 / 60;
    }
    if (this.acc > 1 / 60) this.acc = 0;
    const p = this.world.player(ID);
    for (const n of PART_NAMES) this.farthest = Math.max(this.farthest, Math.abs(p.parts[n].translation().x - STAGE.x));
    // (the walls should make this impossible: if it ever happens, it's logged and the body is put back)
    if (Math.abs(p.center().x - STAGE.x) > this.halfW + 0.5 || p.center().y > STAGE.floorY + 1) {
      this.log.warn('preview_left_stage', { at: { x: Math.round(p.center().x * 100) / 100, y: Math.round(p.center().y * 100) / 100 }, halfW: this.halfW });
      this.world.relocate(ID, { x: STAGE.x, y: STAGE.floorY }, 1);
    }
    const g = this.gfx.clear();
    g.fillStyle(0xffffff, 0.08).fillEllipse(STAGE.x * PX_PER_M, STAGE.floorY * PX_PER_M, 2.2 * PX_PER_M, 0.25 * PX_PER_M);
    const parts = PART_NAMES.map((n) => ({ ...p.parts[n].translation(), a: p.parts[n].rotation() }));
    const squash = this.squash.update(ID, p.grounded, this.world.tick, time);
    drawBody(g, { parts, squash, facing: p.facing, alive: true, color: colorOfSlot(1), headScale: 1, hat: this.hat, gun: { ready: 1, special: null } });
  }
}

/** The character preview on the home page: a small canvas inside `parent`. `destroy()` when the game starts. */
export class CharacterPreview {
  private readonly game: Phaser.Game;
  private readonly scene: PreviewScene;

  constructor(parent: HTMLElement, log: Logger, hat: HatKind) {
    this.scene = new PreviewScene(log);
    this.scene.hat = hat;
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: 240,
      height: 260,
      transparent: true,
      scene: this.scene,
      banner: false,
      audio: { noAudio: true },
    });
  }

  setHat(hat: HatKind): void {
    this.scene.hat = hat;
  }

  destroy(): void {
    this.game.destroy(true);
  }
}
