import Phaser from 'phaser';
import { arenaInfo, buildTestLevel, GameWorld, GUN, HEALTH, LOCAL_PLAYER, MELEE, PART_NAMES, partBits, RAGDOLL, RESPAWN, SPECIAL_KINDS, STAMINA, type Aim, TICK_SECONDS, type ArenaInfo, type ArenaLayout, type GameEvent, type Logger, type Vec2 } from '@ragdoll/shared';
import { Backdrop } from './backdrop';
import { CalloutLayer } from './callouts';
import { FollowCamera } from './camera';
import { DustTracker, feetOf, type DustSample } from './dust';
import { HitFx, nearestPart } from './fx';
import { colorOfSlot, drawBody, drawHazards, drawMovable, drawStatic, partColor, SCENE } from './skin';
import { drawBubble, drawProps, drawSpecialArrow, SPECIAL_LOOK, SpecialFx } from './specials-draw';
import { colorFor, drawBars, drawFace, drawPits, drawPreview, showGameEvent, strokeOutline } from './draw';
import { BulletHoles, drawBullet, drawReach, readyShare } from './gun-draw';
import { launchHud, type HudScene } from './hud';
import { PerfTracker, PlayerInput } from './input';

const MAX_STEPS_PER_FRAME = 5;

/**
 * Offline test range (open with ?mode=local): the whole GameWorld runs right here in the browser.
 * Kept for tuning physics without a server; the preview here is exact.
 */
export class GameScene extends Phaser.Scene {
  private world!: GameWorld;
  private gfx!: Phaser.GameObjects.Graphics;
  private hud!: HudScene;
  private camera!: FollowCamera;
  private input2!: PlayerInput;
  private perf!: PerfTracker;
  /** F2: physics outlines, full predicted path, hit marker, detailed HUD (instead of the cartoon skin). */
  private debugOn = false;
  private stepAcc = 0;
  /** L3: bullet holes in walls (from `impact` events). */
  private readonly holes = new BulletHoles();
  /** Where the gun points this frame (toward the mouse pointer). */
  private aim: Aim | null = null;
  private fx!: SpecialFx;
  private bubbleLabels = new Map<string, Phaser.GameObjects.Text>();
  private lastFrameAt = 0;
  /** L1 look: the arena's sky + silhouettes, hit sparks/chips/flash, two-size callouts. */
  private info!: ArenaInfo;
  private backdrop!: Backdrop;
  private hitFx!: HitFx;
  /** L2: dust puffs (take-off, landing, running, skids). */
  private readonly dust = new DustTracker();
  private callouts!: CalloutLayer;

  constructor(
    private readonly log: Logger,
    /** Arena to play in (`?arena=test_lab&size=narrow`); the Backyard by default. */
    private readonly layout: ArenaLayout,
  ) {
    super('game');
  }

  create(): void {
    this.gfx = this.add.graphics();
    this.hud = launchHud(this);
    this.fx = new SpecialFx(this);
    this.hitFx = new HitFx(this, this.log);
    this.callouts = new CalloutLayer(this, this.hud, this.log);
    this.info = arenaInfo(this.layout);
    this.backdrop = new Backdrop(this, this.info, this.log);
    this.perf = new PerfTracker(this.log);
    this.resetWorld('start');
    if (import.meta.env.DEV) (window as unknown as { scene: GameScene }).scene = this; // for inspecting from devtools
    this.input2 = new PlayerInput(this);
    const kb = this.input.keyboard!;
    kb.on('keydown-F2', () => {
      this.debugOn = !this.debugOn;
      this.backdrop.setVisible(!this.debugOn);
      this.cameras.main.setBackgroundColor(this.debugOn ? SCENE.debugBackground : this.info.palette.sky.bottom);
      this.log.info('debug_toggle', { on: this.debugOn });
    });
    kb.on('keydown-R', () => this.resetWorld('key_r'));
    // Offline testing: 1-8 load a special round into your gun.
    SPECIAL_KINDS.forEach((kind, i) => kb.on(`keydown-${['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT'][i]}`, () => {
      this.world.playerStats(LOCAL_PLAYER).held = kind;
      this.log.info('test_give_special', { kind });
    }));
  }

  update(): void {
    // Real elapsed time. Phaser's own delta is smoothed and capped, which made physics run in slow motion on slow frames.
    const time = performance.now();
    const deltaMs = this.lastFrameAt ? time - this.lastFrameAt : 0;
    this.lastFrameAt = time;
    if (deltaMs > 250) this.log.info('long_frame', { ms: Math.round(deltaMs) }); // tab was hidden, or a hitch
    this.stepAcc += Math.min(deltaMs, 250) / 1000;
    // L3: the gun points at the mouse pointer; click fires, holding fires again each time it's reloaded
    const mine = this.world.players.get(LOCAL_PLAYER);
    this.aim = mine ? this.input2.aimFrom(mine.jointPos('shoulderFront')) : null;
    this.world.setControls(LOCAL_PLAYER, this.input2.read(this.aim));
    if (this.input2.trigger() && this.aim && this.canShoot()) this.world.fire(LOCAL_PLAYER, this.aim);
    let steps = 0;
    // (ticks are paced in real time; the game speed only changes the game time a tick covers)
    while (this.stepAcc >= TICK_SECONDS && steps < MAX_STEPS_PER_FRAME) {
      this.world.step();
      this.stepAcc -= TICK_SECONDS;
      steps++;
    }
    if (this.stepAcc >= TICK_SECONDS) {
      this.log.warn('frame_behind', { droppedMs: Math.round(this.stepAcc * 1000) });
      this.stepAcc = 0;
    }
    this.perf.frame(time, deltaMs, steps);
    for (const ev of this.world.takeEvents()) {
      const line = showGameEvent(this, ev, (id) => id);
      if (ev.type === 'damage') this.onHit(ev);
      else if (ev.type === 'impact') {
        if (ev.on === 'wall') this.holes.add(ev.pos, ev.angle);
        this.hitFx.puff(ev.pos, this.info.palette.dust, 0.45, Math.cos(ev.angle) > 0 ? -1 : 1);
      }
      else if (ev.type === 'callout') this.callouts.show(ev.kind, ev.id, ev.by, ev.pos, ev.size, (id) => id);
      else if (ev.type === 'pickup') this.fx.pickup(ev.pos, ev.kind);
      else if (ev.type === 'wall_splat') this.fx.dent(ev.pos, performance.now());
      else if (ev.type === 'balloon_pop') this.fx.pop(ev.pos);
      else if (ev.type === 'explosion') this.fx.explosion(ev.pos, ev.radius);
      if (line) this.hud.feed(line);
    }
    const me = this.world.players.get(LOCAL_PLAYER);
    const alive = this.world.playerStats(LOCAL_PLAYER).alive;
    this.camera.update(me && alive ? me.center() : null, alive ? this.input2.pointer : null, deltaMs);
    this.draw();
  }

  /** The gun can fire now (same checks the world makes; asking only then keeps `fire_too_soon` out of the log). */
  private canShoot(): boolean {
    return this.world.playerStats(LOCAL_PLAYER).fireBlock(this.world.tick) === null && !this.world.frozen && !this.world.effects.get(LOCAL_PLAYER)?.has('laugh');
  }

  /** Can aim (arms up): alive, not out of stamina, not laughing. */
  private canAim(): boolean {
    const st = this.world.playerStats(LOCAL_PLAYER);
    return st.alive && !st.armsDown && !this.world.effects.get(LOCAL_PLAYER)?.has('laugh');
  }

  /** A hit on a player: spark + chips in the hit part's colour, a white flash on that part, a shake if it involves you. */
  private onHit(ev: Extract<GameEvent, { type: 'damage' }>): void {
    const p = this.world.players.get(ev.id);
    const part = p ? nearestPart(PART_NAMES.map((n) => p.parts[n].translation()), ev.pos) : PART_NAMES.indexOf('torso');
    this.hitFx.hit(ev.pos, partColor(p ? colorOfSlot(this.world.slotOf(ev.id)) : 0xffffff, part), ev.id, part, ev.amount / 20);
    if (ev.id === LOCAL_PLAYER || ev.by === LOCAL_PLAYER) this.hitFx.shake(ev.amount, ev.zone === 'head');
  }

  private resetWorld(reason: string): void {
    this.callouts?.clear();
    this.world?.dispose();
    this.world = new GameWorld(this.log);
    buildTestLevel(this.world, this.layout);
    this.camera = new FollowCamera(this.cameras.main, this.world.bounds, this.log);
    this.camera.snapTo(this.world.player(LOCAL_PLAYER).center());
    this.holes.clear();
    this.log.info('world_reset', { reason, arena: this.layout.id, size: this.layout.size });
  }

  private draw(): void {
    const g = this.gfx;
    g.clear();
    drawPits(g, this.world.arena?.pits ?? []);
    if (this.debugOn) {
      for (const o of this.world.outlines()) strokeOutline(g, o, colorFor(o.label, o.kind, o.label.startsWith(`${LOCAL_PLAYER}:`)), o.sleeping ? 0.45 : 1);
    } else {
      const surfaces = new Map((this.world.arena?.solids ?? []).filter((x) => x.surface).map((x) => [x.label, x.surface!]));
      for (const s of this.world.staticShapes()) drawStatic(g, s, this.info.palette, surfaces.get(s.label));
      drawHazards(g, this.world.arena?.hazards ?? [], performance.now(), (label) => {
        const b = this.world.bodyByLabel(label);
        return b ? { ...b.translation() } : null;
      });
      for (const t of this.bubbleLabels.values()) t.setVisible(false);
      for (const m of this.world.movableBodies()) {
        if (!m.collider.isEnabled()) continue;
        const pose = { ...m.body.translation(), a: m.body.rotation() };
        if (m.kind === 'bubble') drawBubble(this, g, m.label, pose, this.world.specials.bubbles.find((b) => b.label === m.label)?.kind ?? null, this.bubbleLabels);
        else drawMovable(g, m.label, m.shape, pose);
      }
      const byslot = (slot: number) => [...this.world.players.values()].find((p) => this.world.slotOf(p.id) === slot);
      drawProps(
        g,
        this.world.specials.props(),
        (slot, i) => {
          const b = byslot(slot)?.parts[PART_NAMES[i]];
          return b ? { ...b.translation() } : null;
        },
        (slot) => {
          const b = byslot(slot)?.parts.armFrontLower;
          return b ? { ...b.translation() } : null;
        },
        colorOfSlot,
      );
      this.fx.draw(g, performance.now());
    }
    const tops = new Map<string, Vec2>();
    const dustSamples: DustSample[] = [];
    for (const p of this.world.players.values()) {
      const st = this.world.playerStats(p.id);
      dustSamples.push({ id: p.id, feet: feetOf(PART_NAMES.map((n) => ({ ...p.parts[n].translation(), a: p.parts[n].rotation() }))), grounded: p.grounded, alive: st.alive });
      const head = p.parts.head.translation();
      if (this.debugOn) drawFace(g, head, p.parts.head.rotation(), p.facing);
      else {
        const parts = PART_NAMES.map((n) => ({ ...p.parts[n].translation(), a: p.parts[n].rotation() }));
        const dmg = this.world.damage.get(p.id);
        const gun = { ready: readyShare(st.reloadLeft(this.world.tick), GUN.reloadTicks), special: st.held ? SPECIAL_LOOK[st.held].color : null };
        const weapon = dmg?.weapon ?? 'gun';
        // L4: shot-off parts, dents and bullet holes, straight from the world
        const holes = dmg?.holes.map((h) => ({ part: PART_NAMES.indexOf(h.part), x: h.x, y: h.y }));
        drawBody(g, { parts, facing: p.facing, alive: st.alive, color: colorOfSlot(this.world.slotOf(p.id)), headScale: this.world.headScale, crown: this.world.crown === p.id, flash: this.hitFx.flashOf(p.id), gun, lost: partBits([...p.lost]), dents: partBits([...(dmg?.dents ?? [])]), holes, melee: weapon === 'gun' ? undefined : weapon, broken: partBits([...(dmg?.broken ?? [])]) });
      }
      const top = { x: head.x, y: head.y - RAGDOLL.head.r * (this.world.headScale - 1) };
      tops.set(p.id, { x: top.x, y: top.y - 0.45 });
      if (st.alive) drawBars(g, top, st.health / HEALTH.max, st.stamina / STAMINA.max, st.armsDown, st.isProtected(this.world.tick));
    }

    const me = this.world.playerStats(LOCAL_PLAYER);
    const aim = this.aim;
    const mine = colorOfSlot(this.world.slotOf(LOCAL_PLAYER));
    let previewText = '';
    const meleeWeapon = this.world.melee.weaponOf(LOCAL_PLAYER);
    if (aim && this.canAim() && meleeWeapon !== 'gun') {
      // L5: a melee weapon: where a swing can land instead of a bullet path
      drawReach(g, this.world.player(LOCAL_PLAYER).jointPos('shoulderFront'), aim.angle, mine);
      previewText = `GUN KNOCKED AWAY: ${meleeWeapon.toUpperCase()} - click to swing (you run faster, bullets hurt less) until you die`;
    } else if (aim && this.canAim()) {
      const preview = this.world.previewShot(LOCAL_PLAYER, aim);
      drawPreview(g, preview.points, preview.hit?.point ?? null, this.debugOn, mine);
      for (const b of preview.branches ?? []) drawPreview(g, b, null, false, mine);
      previewText = `aim ${Math.round((aim.angle * 180) / Math.PI)}deg  -> ${preview.hit?.label ?? 'nothing'} in ${preview.ticks} ticks`;
    } else if (!me.alive) {
      previewText = 'dead: wait to respawn';
    } else if (me.armsDown) {
      previewText = `out of stamina: arms down until ${STAMINA.recoverAt}`;
    }

    const now = performance.now();
    this.holes.draw(g);
    for (const a of this.world.arrows) {
      if (a.kind !== 'normal') drawSpecialArrow(g, a.pos, a.angle, a.kind, a.state === 'flying', now);
      else if (a.state === 'flying') drawBullet(g, a.pos, a.angle, colorOfSlot(this.world.players.has(a.ownerId) ? this.world.slotOf(a.ownerId) : 1));
    }
    if (!this.debugOn) for (const d of this.dust.update(dustSamples, performance.now())) this.hitFx.puff(d.at, this.info.palette.dust, d.size, d.dir);
    this.hitFx.draw(g, 1 / 60);
    this.callouts.update((id) => tops.get(id) ?? null);

    const c = this.world.counts();
    const lines = [`OFFLINE ${this.layout.name} (${this.layout.size})  [mouse] aim  [click/hold] shoot  [A/D] walk  [W/Space] jump  [S] crouch  [T] taunt  [R] reset  [F2] debug ${this.debugOn ? 'on' : 'off'}`];
    lines.push('score  ' + [...this.world.stats.values()].map((st) => `${st.id} ${st.score} pts (${st.kills} kills / ${st.deaths} deaths)`).join('   '));
    if (this.debugOn) {
      lines.push(`tick ${this.world.tick}  fps ${Math.round(this.game.loop.actualFps)}  arrows flying ${c.flying} stuck ${c.stuck}`);
      for (const p of this.world.players.values()) {
        const st = this.world.playerStats(p.id);
        const state = !st.alive ? `DEAD (back in ${((RESPAWN.delayTicks - (this.world.tick - st.deadSince!)) / 60).toFixed(1)} s)` : p.down ? 'DOWN' : 'up';
        lines.push(
          `${p.id}: ${state}  hp ${Math.ceil(st.health)}  stamina ${Math.floor(st.stamina)}${st.armsDown ? ' (arms down)' : ''}  ${p.grounded ? 'on ground' : 'in air'}  speed ${p.speedX().toFixed(1)}  balance ${p.balance.toFixed(2)}  facing ${p.facing > 0 ? 'right' : 'left'}`,
        );
      }
    }
    const held = this.world.playerStats(LOCAL_PLAYER).held;
    if (held) lines.push(`NEXT ROUND: ${SPECIAL_LOOK[held].name}  (test: [1-8] give yourself one)`);
    if (previewText) lines.push(previewText);
    const enemies = [...this.world.players.values()]
      .filter((p) => p.id !== LOCAL_PLAYER && this.world.playerStats(p.id).alive)
      .map((p) => ({ at: p.center(), color: colorOfSlot(this.world.slotOf(p.id)) }));
    const pointer = this.input2.pointer;
    const fullReload = meleeWeapon !== 'gun' ? MELEE.cooldownTicks : GUN.reloadTicks;
    const reticle = pointer ? { at: pointer, ready: readyShare(me.reloadLeft(this.world.tick), fullReload), color: mine, blocked: !this.canAim() } : null;
    this.hud.render({ lines, reticle, offscreen: this.camera.offscreen(enemies), banner: null });
  }
}
