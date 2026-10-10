import Phaser from 'phaser';
import { arenaInfo, BotBrain, buildArena, buildTestLevel, DUMMY_PLAYER, PART_SHAPES, GameWorld, GUN, HEALTH, LOCAL_PLAYER, PART_NAMES, partBits, RAGDOLL, RESPAWN, SPECIAL_KINDS, STAMINA, type Aim, TICK_SECONDS, type ArenaInfo, type ArenaLayout, type GameEvent, type Logger, type Vec2 } from '@ragdoll/shared';
import { Backdrop } from './backdrop';
import { CalloutLayer } from './callouts';
import { FollowCamera } from './camera';
import { DustTracker, feetOf, solesOf, type DustSample } from './dust';
import { CartoonSmoke } from './smoke';
import { HitFx, nearestPart } from './fx';
import { colorOfSlot, drawBody, drawHazards, drawMovable, drawStatic, LandingSquash, partColor, SCENE } from './skin';
import { drawBubble, drawProps, drawSpecialArrow, SPECIAL_LOOK, SpecialFx } from './specials-draw';
import { colorFor, drawAimDot, drawBars, drawShield, drawFace, drawPits, drawPreview, showGameEvent, strokeOutline } from './draw';
import { BulletHoles, drawBullet, readyShare } from './gun-draw';
import { DragTrail, shinEnd } from './drag-trail';
import { launchHud, type HudScene } from './hud';
import { PerfTracker, PlayerInput } from './input';

const MAX_STEPS_PER_FRAME = 5;

/**
 * M4 showcase (the live fight behind the home page): this many bots, the camera's slow drift between them, and how
 * often it picks someone else to watch (sooner when there's a kill).
 */
const SHOWCASE = { bots: 4, focusMs: 7000, drift: 0.35, resetMs: 150_000 } as const;

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
  /** L2: dust moments (take-off, landing, push-offs, skids), drawn as T6 cartoon smoke. */
  private readonly dust = new DustTracker();
  private smoke!: CartoonSmoke;
  private callouts!: CalloutLayer;
  /** L7: dust and scuff marks behind a dragged (limp) foot. */
  private readonly dragTrail = new DragTrail();
  /** L7: the landing squash. */
  private readonly squash = new LandingSquash();
  /** `?bot=1`: the other player is a filler bot (the server's brain), not a still dummy. */
  private bot: BotBrain | null = null;
  /** M4 showcase: bots only (no local player, no input), the camera watching one of them. */
  private readonly showBots = new Map<string, BotBrain>();
  private focus: { id: string; since: number } | null = null;
  private resetAt = 0;

  constructor(
    private readonly log: Logger,
    /** Arena to play in (`?arena=test_lab&size=narrow`); the Backyard by default. */
    private readonly layout: ArenaLayout,
    private readonly botOn = false,
    /** M4: the home page's live background: bots fight, nobody plays, no HUD text. */
    private readonly showcase = false,
  ) {
    super('game');
  }

  create(): void {
    this.gfx = this.add.graphics();
    this.hud = launchHud(this);
    this.fx = new SpecialFx(this);
    this.hitFx = new HitFx(this, this.log);
    this.smoke = new CartoonSmoke(this, this.log);
    this.callouts = new CalloutLayer(this, this.hud, this.log);
    this.info = arenaInfo(this.layout);
    this.backdrop = new Backdrop(this, this.info, this.log);
    this.perf = new PerfTracker(this.log);
    this.resetWorld('start');
    if (this.showcase) return; // (no input: clicks belong to the menu on top)
    if (import.meta.env.DEV) (window as unknown as { scene: GameScene }).scene = this; // for inspecting from devtools
    this.input2 = new PlayerInput(this, this.log);
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
    if (!this.showcase) {
      // L3: the gun points at the mouse pointer; click fires, holding fires again each time it's reloaded
      const mine = this.world.players.get(LOCAL_PLAYER);
      this.aim = mine ? this.input2.aimFrom(mine.facing) : null;
      this.world.setControls(LOCAL_PLAYER, this.input2.read(this.aim));
      // (L7 melee: one click = one swing; the gun keeps firing while held)
      if (this.input2.trigger(this.world.melee.weaponOf(LOCAL_PLAYER) === 'gun') && this.aim && this.canShoot()) this.world.fire(LOCAL_PLAYER, this.aim);
    } else if (time > this.resetAt) this.resetWorld('showcase_refresh');
    let steps = 0;
    // (ticks are paced in real time; the game speed only changes the game time a tick covers)
    while (this.stepAcc >= TICK_SECONDS && steps < MAX_STEPS_PER_FRAME) {
      this.botThink();
      this.world.step();
      this.stepAcc -= TICK_SECONDS;
      steps++;
    }
    if (this.stepAcc >= TICK_SECONDS) {
      // (the showcase behind the menu just skips ahead: a slow phone shouldn't fill the log)
      if (!this.showcase) this.log.warn('frame_behind', { droppedMs: Math.round(this.stepAcc * 1000) });
      this.stepAcc = 0;
    }
    if (!this.showcase) this.perf.frame(time, deltaMs, steps, () => ({ ...this.input2.aimReport(), ...this.smoke.report() }));
    for (const ev of this.world.takeEvents()) {
      if (this.showcase && ev.type === 'death' && ev.killer) this.focus = { id: ev.killer, since: time }; // watch the winner
      const line = this.showcase ? null : showGameEvent(this, ev, (id) => id);
      if (ev.type === 'damage') this.onHit(ev);
      else if (ev.type === 'thud') this.hitFx.puff(ev.pos, this.info.palette.dust, ev.size, 0); // L7: a lost leg lands
      else if (ev.type === 'impact') {
        if (ev.on === 'shield') this.hitFx.spark(ev.pos);
        else if (ev.on === 'wall') this.holes.add(ev.pos, ev.angle);
        if (ev.on !== 'shield') this.hitFx.puff(ev.pos, this.info.palette.dust, 0.45, Math.cos(ev.angle) > 0 ? -1 : 1);
      }
      else if (ev.type === 'callout') this.callouts.show(ev.kind, ev.id, ev.by, ev.pos, ev.size, (id) => id);
      else if (ev.type === 'pickup') this.fx.pickup(ev.pos, ev.kind);
      else if (ev.type === 'wall_splat') this.fx.dent(ev.pos, performance.now());
      else if (ev.type === 'balloon_pop') this.fx.pop(ev.pos);
      else if (ev.type === 'explosion') this.fx.explosion(ev.pos, ev.radius);
      if (line) this.hud.feed(line);
    }
    if (this.showcase) this.camera.update(this.showcaseTarget(time), null, deltaMs * SHOWCASE.drift);
    else {
      const me = this.world.players.get(LOCAL_PLAYER);
      const alive = this.world.playerStats(LOCAL_PLAYER).alive;
      this.camera.update(me && alive ? me.center() : null, alive ? this.input2.offset : null, deltaMs);
    }
    this.draw();
  }

  /** M4 showcase: who the camera watches (a living bot; someone else every few seconds). */
  private showcaseTarget(now: number): Vec2 | null {
    const alive = [...this.world.players.keys()].filter((id) => this.world.playerStats(id).alive);
    if (!alive.length) return null;
    if (!this.focus || !alive.includes(this.focus.id) || now - this.focus.since > SHOWCASE.focusMs) {
      const others = alive.filter((id) => id !== this.focus?.id);
      const pick = (others.length ? others : alive)[Math.floor(Math.random() * (others.length || alive.length))];
      this.focus = { id: pick, since: now };
    }
    return this.world.player(this.focus.id).center();
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

  /**
   * Offline bot: its actions go into the world the way the room applies them (controls stay until the next input; a
   * shot only once its reload is done, as the room's queue does), so it plays like an online filler bot.
   */
  private botThink(): void {
    for (const [id, brain] of this.showBots) {
      for (const a of brain.think(this.world)) {
        if (a.t === 'input') this.world.setControls(id, { aim: a.aim === null ? null : { angle: a.aim }, crouch: a.crouch, jump: a.jump, move: a.move, taunt: false });
        else if (this.world.playerStats(id).reloadLeft(this.world.tick) === 0) this.world.fire(id, { angle: a.angle });
      }
    }
    if (!this.bot) return;
    for (const a of this.bot.think(this.world)) {
      if (a.t === 'input') this.world.setControls(DUMMY_PLAYER, { aim: a.aim === null ? null : { angle: a.aim }, crouch: a.crouch, jump: a.jump, move: a.move, taunt: false });
      else if (this.world.playerStats(DUMMY_PLAYER).reloadLeft(this.world.tick) === 0) this.world.fire(DUMMY_PLAYER, { angle: a.angle });
    }
  }

  private resetWorld(reason: string): void {
    this.callouts?.clear();
    this.smoke?.clear();
    this.world?.dispose();
    this.world = new GameWorld(this.log);
    this.showBots.clear();
    if (this.showcase) {
      buildArena(this.world, this.layout);
      for (let i = 1; i <= SHOWCASE.bots; i++) {
        this.world.spawnPlayer(`b${i}`);
        this.showBots.set(`b${i}`, new BotBrain(`b${i}`, Math.floor(Math.random() * 1e6)));
      }
      this.resetAt = performance.now() + SHOWCASE.resetMs;
      this.focus = null;
    } else buildTestLevel(this.world, this.layout);
    this.bot = this.botOn && !this.showcase ? new BotBrain(DUMMY_PLAYER, 1) : null;
    this.camera = new FollowCamera(this.cameras.main, this.world.bounds, this.log);
    this.camera.snapTo(this.world.player(this.showcase ? 'b1' : LOCAL_PLAYER).center());
    this.holes.clear();
    this.dragTrail?.clear();
    this.log.info('world_reset', { reason, arena: this.layout.id, size: this.layout.size, bot: this.botOn });
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
      const poses = PART_NAMES.map((n) => ({ ...p.parts[n].translation(), a: p.parts[n].rotation() }));
      dustSamples.push({ id: p.id, feet: feetOf(poses), soles: solesOf(poses), grounded: p.grounded, alive: st.alive });
      const head = p.parts.head.translation();
      if (this.debugOn) drawFace(g, head, p.parts.head.rotation(), p.facing);
      else {
        const parts = PART_NAMES.map((n) => ({ ...p.parts[n].translation(), a: p.parts[n].rotation() }));
        const dmg = this.world.damage.get(p.id);
        const gun = { ready: readyShare(st.reloadLeft(this.world.tick), GUN.reloadTicks), special: st.held ?? null };
        const weapon = dmg?.weapon ?? 'gun';
        const drawing = this.world.melee.drawing(p.id); // L7: empty hands while the weapon is drawn after a disarm
        // L4: shot-off parts, dents and bullet holes, straight from the world
        const holes = dmg?.holes.map((h) => ({ part: PART_NAMES.indexOf(h.part), x: h.x, y: h.y }));
        const squash = this.squash.update(p.id, p.grounded, this.world.tick, performance.now());
        drawBody(g, { squash, parts, facing: p.facing, alive: st.alive, color: colorOfSlot(this.world.slotOf(p.id)), headScale: this.world.headScale, crown: this.world.crown === p.id, flash: this.hitFx.flashOf(p.id), gun: drawing ? undefined : gun, lost: partBits([...p.lost]), dents: partBits([...(dmg?.dents ?? [])]), holes, melee: weapon === 'gun' || drawing ? undefined : weapon, broken: partBits([...(dmg?.broken ?? [])]), bandaged: st.alive ? p.mods.dragLeg : null });
        // L7: the dragged foot scrapes along the ground: dust puffs and fading scuff marks
        const shinName = st.alive && p.mods.dragLeg ? (p.mods.dragLeg === 'front' ? 'legFrontLower' : 'legBackLower') : null;
        const shinPose = shinName && !p.lost.has(shinName) ? parts[PART_NAMES.indexOf(shinName)] : null;
        this.dragTrail.update(p.id, shinPose && shinName ? shinEnd(shinPose, (PART_SHAPES[shinName] as { hy: number }).hy) : null, p.grounded, performance.now(), (at, dir) => this.hitFx.puff(at, this.info.palette.dust, 0.25, dir));
      }
      const top = { x: head.x, y: head.y - RAGDOLL.head.r * (this.world.headScale - 1) };
      tops.set(p.id, { x: top.x, y: top.y - 0.45 });
      if (st.alive) drawBars(g, top, st.health / HEALTH.max, st.stamina / STAMINA.max, st.armsDown, st.isProtected(this.world.tick));
      if (st.alive && st.isProtected(this.world.tick)) {
        const torso = p.parts.torso.translation();
        drawShield(g, { x: torso.x, y: torso.y }, colorOfSlot(this.world.slotOf(p.id)), st.protectedUntil - this.world.tick <= RESPAWN.shieldFlickerTicks, performance.now());
      }
    }

    if (this.showcase) {
      // (no aim, no text: just the fight and its banners)
      this.holes.draw(g);
      for (const a of this.world.arrows) {
        if (a.kind !== 'normal') drawSpecialArrow(g, a.pos, a.angle, a.kind, a.state === 'flying', performance.now());
        else if (a.state === 'flying') drawBullet(g, a.pos, a.angle, colorOfSlot(this.world.players.has(a.ownerId) ? this.world.slotOf(a.ownerId) : 1));
      }
      for (const d of this.dust.update(dustSamples, performance.now())) this.smoke.puff(d);
      this.smoke.update(1 / 60, g);
      this.hitFx.draw(g, 1 / 60);
      this.dragTrail.draw(g, performance.now());
      this.callouts.update((id) => tops.get(id) ?? null);
      this.hud.render({ lines: [], offscreen: [], banner: null });
      return;
    }
    const me = this.world.playerStats(LOCAL_PLAYER);
    const aim = this.aim;
    const mine = colorOfSlot(this.world.slotOf(LOCAL_PLAYER));
    let previewText = '';
    const meleeWeapon = this.world.melee.weaponOf(LOCAL_PLAYER);
    if (aim && this.canAim() && meleeWeapon !== 'gun') {
      // (L7: a melee weapon shows no pointer and no reach fan: the swing goes the way you face)
      previewText = this.world.melee.drawing(LOCAL_PLAYER) ? `GUN LOST! drawing your ${meleeWeapon}...` : `GUN LOST: ${meleeWeapon} until you respawn - click to swing`;
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
    if (me.alive && meleeWeapon === 'gun') drawAimDot(g, this.input2.aimPoint(this.world.player(LOCAL_PLAYER).jointPos('shoulderFront')), mine);

    const now = performance.now();
    this.holes.draw(g);
    for (const a of this.world.arrows) {
      if (a.kind !== 'normal') drawSpecialArrow(g, a.pos, a.angle, a.kind, a.state === 'flying', now);
      else if (a.state === 'flying') drawBullet(g, a.pos, a.angle, colorOfSlot(this.world.players.has(a.ownerId) ? this.world.slotOf(a.ownerId) : 1));
    }
    if (!this.debugOn) for (const d of this.dust.update(dustSamples, performance.now())) this.smoke.puff(d);
    this.smoke.update(1 / 60, g);
    this.hitFx.draw(g, 1 / 60);
    this.dragTrail.draw(g, performance.now());
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
      .map((p) => ({ at: p.center(), color: colorOfSlot(this.world.slotOf(p.id)), stump: p.stumps.size > 0 }));
    this.hud.render({ lines, offscreen: this.camera.offscreen(enemies), banner: null });
  }
}
