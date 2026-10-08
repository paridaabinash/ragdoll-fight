import Phaser from 'phaser';
import {
  GUN,
  EFFECT_BIT,
  GRAVITY_Y,
  gravityShareAt,
  MODIFIER_NAMES,
  modifierOn,
  HEALTH,
  launchVelocity,
  NET,
  outlineOf,
  PART_NAMES,
  PART_SHAPES,
  r2,
  RAGDOLL,
  raycastShapes,
  RESPAWN,
  shoulderFrontFrom,
  STAMINA,
  stepArrow,
  SPECIAL,
  traceShot,
  traceSplitShot,
  windAt,
  DT,
  DAMAGE,
  LEG_STAGE_NAMES,
  MELEE,
  type Aim,
  type GameEvent,
  type HatKind,
  type Logger,
  type MatchInfo,
  type NetPlayer,
  type PlacedShape,
  type SnapshotData,
  type Vec2,
} from '@ragdoll/shared';
import { Backdrop } from './backdrop';
import { CalloutLayer } from './callouts';
import { FollowCamera } from './camera';
import { DustTracker, feetOf, type DustSample } from './dust';
import { HitFx, nearestPart } from './fx';
import { colorOfSlot, drawBody, drawHazards, drawMovable, drawStatic, FlyingHats, partColor, SCENE } from './skin';
import { drawBubble, drawProps, drawSpecialArrow, SPECIAL_LOOK, SpecialFx } from './specials-draw';
import { COLORS, colorFor, drawBars, drawFace, drawPits, drawPreview, px, showGameEvent, strokeOutline } from './draw';
import { BulletHoles, drawBullet, drawReach, readyShare } from './gun-draw';
import { launchHud, type HudScene } from './hud';
import { PerfTracker, PlayerInput } from './input';
import { matchBanner, matchLine, modifierHeadline } from './match-hud';
import type { NetClient, WorldVersion } from './net-client';
import type { HatProgress } from './progress';

const HEAD = PART_NAMES.indexOf('head');
const TORSO = PART_NAMES.indexOf('torso');
const ARM_UPPER = PART_NAMES.indexOf('armFrontUpper');
const ARM_LOWER = PART_NAMES.indexOf('armFrontLower');
/** A stand-in bullet is dropped if the server hasn't shown the real one by then. */
const PLACEHOLDER_MAX_MS = 1500;

/** Bullet shown the moment you click, until the server's real bullet appears. Cosmetic only. */
interface Placeholder {
  seq: number;
  pos: Vec2;
  vel: Vec2;
  flying: boolean;
  born: number;
  lastStepAt: number;
}


/**
 * Online play: draws the server's game ~100 ms in the past, blended between snapshots.
 * Your own gun arm, aim preview and a stand-in bullet react instantly; everything else comes from the server.
 */
export class NetScene extends Phaser.Scene {
  private gfx!: Phaser.GameObjects.Graphics;
  private hud!: HudScene;
  private camera!: FollowCamera;
  /** The camera jumps to you on your first frame and after each respawn, instead of sliding across the arena. */
  private snapCamera = true;
  private input2!: PlayerInput;
  private perf!: PerfTracker;
  private names = new Map<number, Phaser.GameObjects.Text>();
  private placeholders: Placeholder[] = [];
  /** L3: bullet holes in walls (from `impact` events), cleared each match. */
  private readonly holes = new BulletHoles();
  /** Where the gun points this frame (toward the mouse pointer), before any arm-hit swing. */
  private aim: Aim | null = null;
  private fx!: SpecialFx;
  private bubbleLabels = new Map<string, Phaser.GameObjects.Text>();
  /** F2: physics outlines + extra info instead of the cartoon skin. */
  private debugOn = false;
  private lastFrameAt = 0;
  /** L1 look: the arena's sky + silhouettes, hit sparks/chips/flash, two-size callouts. */
  private backdrop!: Backdrop;
  private hitFx!: HitFx;
  /** L2: dust puffs from what's drawn (take-off, landing, running, skids). */
  private readonly dust = new DustTracker();
  private callouts!: CalloutLayer;
  /** The world (match arena) on screen now; a new one swaps in when the delayed picture reaches its first tick. */
  private shown!: WorldVersion;
  /** Extra downward push on arrows in Moon Gravity (m/s²; 0 normally), for the preview and stand-in arrows. */
  private extraGravity = 0;
  /** Players whose hat was shot off (back at respawn). */
  private hatOff = new Set<string>();
  /** L4: bullet holes per player id (from damage events; they stay until that player respawns, even through an apple). */
  private readonly bodyHoles = new Map<string, { part: number; x: number; y: number }[]>();
  private readonly flyingHats = new FlyingHats();
  /** Last chaos-round state on screen, for the log. */
  private shownModifier = '';

  constructor(
    private readonly log: Logger,
    private readonly net: NetClient,
    /** Address other devices on the network open to play (empty if unknown). */
    private readonly shareUrl = '',
    /** Hat unlock progress (kept on this device). */
    private readonly progress?: HatProgress,
  ) {
    super('net');
  }

  create(): void {
    this.gfx = this.add.graphics();
    this.hud = launchHud(this);
    this.fx = new SpecialFx(this);
    this.shown = this.net.worldAt(Infinity);
    // L4: the holes people already had when you joined (later ones come with the damage events)
    for (const h of this.net.welcome.holes ?? []) this.bodyHoles.set(h.id, [...h.holes]);
    for (const h of this.net.welcome.wallHoles ?? []) this.holes.add(h, h.angle);
    for (const id of this.net.welcome.hatsOff ?? []) this.hatOff.add(id);
    this.camera = new FollowCamera(this.cameras.main, this.shown.arena, this.log);
    this.backdrop = new Backdrop(this, this.shown.arena, this.log);
    this.hitFx = new HitFx(this, this.log);
    this.callouts = new CalloutLayer(this, this.hud, this.log);
    this.perf = new PerfTracker(this.log);
    this.input2 = new PlayerInput(this);
    this.input.keyboard!.on('keydown-F2', () => {
      this.debugOn = !this.debugOn;
      this.backdrop.setVisible(!this.debugOn);
      this.cameras.main.setBackgroundColor(this.debugOn ? SCENE.debugBackground : this.shown.arena.palette.sky.bottom);
      this.log.info('debug_toggle', { on: this.debugOn });
    });
    if (import.meta.env.DEV) (window as unknown as { scene: NetScene }).scene = this; // for inspecting from devtools
  }

  update(): void {
    const now = performance.now();
    const deltaMs = this.lastFrameAt ? now - this.lastFrameAt : 0;
    this.lastFrameAt = now;
    this.perf.frame(now, deltaMs, 0, () => ({ rttMs: this.net.rttMs }));

    const view = this.net.buffer.sample(now);
    const fresh = this.net.latest();
    // L3: the gun points at the mouse pointer, from your shoulder as you're drawn (the newest snapshot)
    const mine = fresh ? this.me(fresh, view ?? undefined) : undefined;
    this.aim = mine?.alive ? this.input2.aimFrom(shoulderFrontFrom(mine.parts[TORSO], mine.parts[TORSO].a)) : null;
    this.net.sendInput(this.input2.read(this.aim));
    const trigger = this.input2.trigger();
    if (!view || !fresh) {
      this.hud.render({ lines: ['waiting for the first snapshot...'], reticle: null, offscreen: [], banner: null });
      return;
    }
    const renderTick = this.net.buffer.renderTick(now);
    const world = this.net.worldAt(view.tick);
    if (world !== this.shown) {
      // A new match: new arena, new camera limits, and the camera jumps to wherever you spawned.
      this.shown = world;
      this.camera = new FollowCamera(this.cameras.main, world.arena, this.log);
      this.backdrop.destroy();
      this.backdrop = new Backdrop(this, world.arena, this.log);
      this.backdrop.setVisible(!this.debugOn);
      if (this.debugOn) this.cameras.main.setBackgroundColor(SCENE.debugBackground);
      this.callouts.clear();
      this.snapCamera = true;
      this.placeholders = [];
      this.holes.clear();
      this.bodyHoles.clear();
      this.hatOff.clear();
      this.log.info('arena_shown', { arena: world.arena.id, size: world.arena.size, fromTick: world.fromTick, renderTick: Math.round(renderTick) });
    }
    // Events are shown when the (delayed) picture reaches them, so a damage number appears as the arrow lands.
    const due = this.net.pendingEvents.filter((e) => e.tick <= renderTick);
    this.net.pendingEvents = this.net.pendingEvents.filter((e) => e.tick > renderTick);
    const you = this.net.welcome.you;
    for (const { ev } of due) {
      this.onEvent(ev, view);
      for (const hat of this.progress?.event(ev, you) ?? []) this.hud.feed(`NEW HAT UNLOCKED: ${hat}! (pick it when you join)`, 8000);
      const line = showGameEvent(this, ev, (id) => this.net.nameOf(id));
      if (ev.type === 'damage') this.onHit(ev, view);
      else if (ev.type === 'impact') this.onImpact(ev);
      else if (ev.type === 'callout') this.callouts.show(ev.kind, ev.id, ev.by, ev.pos, ev.size, (id) => this.net.nameOf(id));
      else if (ev.type === 'pickup') this.fx.pickup(ev.pos, ev.kind);
      else if (ev.type === 'wall_splat') this.fx.dent(ev.pos, now);
      else if (ev.type === 'balloon_pop') this.fx.pop(ev.pos);
      else if (ev.type === 'explosion') this.fx.explosion(ev.pos, ev.radius);
      if (line) this.hud.feed(line);
      if (ev.type === 'respawn' && ev.id === you) this.snapCamera = true;
    }
    const serverNow = renderTick + NET.interpDelayTicks;
    // Moon Gravity bends the preview exactly like the server's arrows (same field: wind + the missing share of gravity)
    this.extraGravity = (gravityShareAt(this.net.matchAt(Infinity).modifier, serverNow) - 1) * GRAVITY_Y;
    const match = this.net.matchAt(renderTick);
    this.logModifier(match, serverNow);
    if (this.progress) {
      for (const hat of this.progress.result(match, you)) this.hud.feed(`NEW HAT UNLOCKED: ${hat}! (pick it when you join)`, 8000);
      if (match.phase === 'playing' && fresh.players.find((p) => p.slot === this.mySlot)?.crown) for (const hat of this.progress.crown(deltaMs)) this.hud.feed(`NEW HAT UNLOCKED: ${hat}!`, 8000);
    }

    const me = this.me(fresh, view);
    const torso = me?.alive ? me.parts[TORSO] : null;
    if (torso && this.snapCamera) {
      this.camera.snapTo(torso);
      this.snapCamera = false;
    }
    // the view leans toward the pointer (L3), so looking far ahead is a choice
    this.camera.update(torso, me?.alive ? this.input2.pointer : null, deltaMs);
    if (trigger && match.phase === 'playing') this.fire(now);
    this.draw(view, fresh, renderTick, now, deltaMs);
  }

  /** A bullet hit a wall/floor (a hole + dust) or a crate (dust). */
  private onImpact(ev: Extract<GameEvent, { type: 'impact' }>): void {
    if (ev.on === 'wall') this.holes.add(ev.pos, ev.angle);
    this.hitFx.puff(ev.pos, this.shown.arena.palette.dust, 0.45, Math.cos(ev.angle) > 0 ? -1 : 1);
  }

  /** Game events with something to do beyond the banner: hats flying off. */
  private onEvent(ev: GameEvent, view: SnapshotData): void {
    if (ev.type === 'damage' && ev.zone === 'head' && !this.hatOff.has(ev.id)) {
      const hat = this.hatOf(ev.id);
      const slot = this.net.roster.find((r) => r.id === ev.id)?.slot;
      const p = view.players.find((x) => x.slot === slot);
      if (hat !== 'none' && p) {
        this.hatOff.add(ev.id);
        this.flyingHats.add(hat, p.parts[HEAD], ev.pos, p.facing);
        this.log.info('hat_off', { id: ev.id, hat, by: ev.by });
      }
    } else if (ev.type === 'respawn') {
      this.hatOff.delete(ev.id);
      this.bodyHoles.delete(ev.id);
    }
  }

  /** A hit on a player: spark + chips in the hit part's colour, a white flash on that part, a shake if it involves you. */
  private onHit(ev: Extract<GameEvent, { type: 'damage' }>, view: SnapshotData): void {
    const slot = this.net.roster.find((r) => r.id === ev.id)?.slot;
    const p = view.players.find((x) => x.slot === slot);
    // L4: the server says which part (and where in it) the bullet hole is
    const part = ev.hole ? ev.hole.part : p ? nearestPart(p.parts, ev.pos) : TORSO;
    if (ev.hole) {
      const list = this.bodyHoles.get(ev.id) ?? [];
      list.push(ev.hole);
      if (list.length > DAMAGE.maxHoles) list.splice(0, list.length - DAMAGE.maxHoles);
      this.bodyHoles.set(ev.id, list);
    }
    this.hitFx.hit(ev.pos, partColor(slot ? colorOfSlot(slot) : 0xffffff, part), ev.id, part, ev.amount / 20);
    const you = this.net.welcome.you;
    if (ev.id === you || ev.by === you) this.hitFx.shake(ev.amount, ev.zone === 'head');
  }

  /** Logs chaos-round changes as the screen shows them (announced / on / off). */
  private logModifier(m: MatchInfo, serverNow: number): void {
    const c = m.modifier;
    const state = c ? `${c.kind}:${modifierOn(c, serverNow) ? 'on' : serverNow < c.start ? 'announced' : 'over'}` : '';
    if (state === this.shownModifier) return;
    this.shownModifier = state;
    this.log.info('modifier_shown', { state: state || 'none', start: c?.start ?? null, end: c?.end ?? null, serverNow: Math.round(serverNow), gravity: r2(this.extraGravity) });
  }

  private hatOf(id: string): HatKind {
    return this.net.roster.find((r) => r.id === id)?.hat ?? 'none';
  }

  /** Wind push on arrows (S6), from the arena on screen: the same function the server uses, so the preview bends exactly. */
  /** Moon Gravity (S7) adds the missing share of gravity in the same field, exactly as the server's `arrowField`. */
  private wind = (p: Vec2): Vec2 => {
    const w = windAt(this.shown.arena.hazards, p);
    return this.extraGravity ? { x: w.x, y: w.y + this.extraGravity } : w;
  };

  /** Can't shoot right now (the server would refuse it): dead, arms down, laughing. */
  private gunBlocked(me: NetPlayer | undefined): boolean {
    return !me?.alive || me.armsDown || (me.fx & EFFECT_BIT.laugh) !== 0;
  }

  private get mySlot(): number {
    return this.net.welcome.slot;
  }

  /**
   * Your own body is drawn from the newest snapshot (no smoothing delay), so it reacts sooner.
   * Right at a match change the newest snapshot can already be the next arena: then use the one on screen.
   */
  private me(fresh: SnapshotData, view?: SnapshotData): NetPlayer | undefined {
    const src = view && this.net.worldAt(fresh.tick) !== this.net.worldAt(view.tick) ? view : fresh;
    return src.players.find((p) => p.slot === this.mySlot);
  }

  /**
   * Click / held trigger: fires when this client's own reload is done (L3; the server checks it again by its tick).
   * The stand-in bullet starts at once, from the same shot code the server uses.
   */
  private fire(now: number): void {
    const fresh = this.net.latest();
    const me = fresh ? this.me(fresh) : undefined;
    const aim = this.aim;
    if (!aim || !me || this.gunBlocked(me) || !this.net.gunReady(now)) return; // the server would refuse it anyway
    if (me.weapon !== 'gun') {
      // L5: the gun was knocked away: the click swings the melee weapon (the server swings it; snapshots show it)
      this.net.fire(aim, MELEE.cooldownTicks, true);
      return;
    }
    const real = aim; // (L7: the gun never wobbles: the bullet goes exactly where you aim)
    const seq = this.net.fire(aim, GUN.reloadTicks);
    const view = this.net.buffer.sample(now) ?? fresh!; // me exists, so fresh does
    const shot = traceShot(shoulderFrontFrom(me.parts[TORSO], me.parts[TORSO].a), real, (a, b) => raycastShapes(a, b, this.sceneShapes(view)), this.shown.arena, this.wind);
    const blocked = shot.ticks === 0 && shot.hit !== null; // hits a wall / player within arm's reach right away
    this.placeholders.push({ seq, pos: shot.points[0], vel: launchVelocity(real), flying: !blocked, born: now, lastStepAt: now });
  }

  /** Everything a bullet could hit, as plain shapes (for the preview and stand-in bullets). */
  private sceneShapes(view: SnapshotData): PlacedShape[] {
    const shapes: PlacedShape[] = this.shown.statics.map((s) => ({ ...s }));
    for (const b of view.bodies) {
      const info = this.shown.bodies[b.index];
      if (info && b.enabled) shapes.push({ label: info.label, shape: info.shape, pos: b.pose, angle: b.pose.a });
    }
    for (const p of view.players) {
      if (p.slot === this.mySlot) continue;
      PART_NAMES.forEach((n, i) => shapes.push({ label: `slot${p.slot}:${n}`, shape: n === 'head' ? { r: RAGDOLL.head.r * view.headScale } : PART_SHAPES[n], pos: p.parts[i], angle: p.parts[i].a }));
    }
    return shapes;
  }

  private draw(view: SnapshotData, fresh: SnapshotData, renderTick: number, now: number, deltaMs: number): void {
    const g = this.gfx;
    g.clear();
    drawPits(g, this.shown.arena.pits);
    const surfaces = new Map(this.shown.arena.surfaces.map((x) => [x.label, x.surface]));
    for (const s of this.shown.statics) {
      if (this.debugOn) strokeOutline(g, outlineOf(s.shape, s.pos, s.angle), COLORS.fixed);
      else drawStatic(g, s, this.shown.arena.palette, surfaces.get(s.label));
    }
    const bodyAt = (label: string) => {
      const i = this.shown.bodies.findIndex((b) => b.label === label);
      return view.bodies.find((b) => b.index === i)?.pose ?? null;
    };
    drawHazards(g, this.shown.arena.hazards, now, bodyAt);
    for (const t of this.bubbleLabels.values()) t.setVisible(false);
    for (const b of view.bodies) {
      const info = this.shown.bodies[b.index];
      if (!info || !b.enabled) continue;
      if (this.debugOn) strokeOutline(g, outlineOf(info.shape, b.pose, b.pose.a), colorFor(info.label, 'dynamic', false));
      else if (info.kind === 'bubble') drawBubble(this, g, info.label, b.pose, b.holds, this.bubbleLabels);
      else drawMovable(g, info.label, info.shape, b.pose);
    }
    // puddles, balloons, plunger ropes (tied to body parts as drawn now)
    const slotParts = (slot: number) => view.players.find((p) => p.slot === slot)?.parts;
    drawProps(
      g,
      view.props,
      (slot, i) => slotParts(slot)?.[i] ?? null,
      (slot) => slotParts(slot)?.[ARM_LOWER] ?? null,
      colorOfSlot,
    );
    this.fx.draw(g, now);

    const me = this.me(fresh, view);
    const intended = this.aim;
    const aiming = !!intended && !this.gunBlocked(me);
    const match = this.net.matchAt(renderTick);
    const serverNow = renderTick + NET.interpDelayTicks;
    // Boxing Gloves Only: every shot is a glove (a held round waits), so no banana split in the preview
    const gloves = match.modifier?.kind === 'glove_only' && modifierOn(match.modifier, serverNow);
    const aim = intended;
    const shapes = this.sceneShapes(view);
    // (a held banana splits into three: the preview shows all three paths, traced exactly like the server will)
    const shoulder = me ? shoulderFrontFrom(me.parts[TORSO], me.parts[TORSO].a) : null;
    const ray = (a: Vec2, b: Vec2) => raycastShapes(a, b, shapes);
    // L5: with a melee weapon there's no bullet path (a reach fan instead) and the arm isn't pointed locally (the swing
    // is the server's: the snapshots show it)
    const melee = me && me.weapon !== 'gun' ? me.weapon : null;
    const shot =
      aiming && me && shoulder && !melee
        ? me.held === 'banana' && !gloves
          ? traceSplitShot(shoulder, aim!, ray, this.shown.arena, SPECIAL.banana.splitTicks, SPECIAL.banana.spread, this.wind)
          : traceShot(shoulder, aim!, ray, this.shown.arena, this.wind)
        : null;
    // Same rule as the server's ragdoll: aiming into something within arm's reach lowers the gun arm.
    const armUp = aiming && !melee && !(shot && shot.ticks === 0 && shot.hit);
    const seen = new Set<number>();
    const dustSamples: DustSample[] = [];
    /** Top of each player's head bars by id, for the callout tags. */
    const tops = new Map<string, Vec2>();
    for (const p of view.players) {
      const isMe = p.slot === this.mySlot;
      const body = isMe && me ? me : p;
      seen.add(p.slot);
      // Instant local feel: your gun arm points where you aim right away, before the server's arm catches up.
      const poses = body.parts.map((pose, i) => (isMe && armUp && (i === ARM_UPPER || i === ARM_LOWER) ? this.aimedArmPose(body, aim!, i === ARM_UPPER ? 0.2 : 0.6) : pose));
      const head = body.parts[HEAD];
      const id = this.net.roster.find((r) => r.slot === p.slot)?.id;
      if (this.debugOn) {
        PART_NAMES.forEach((n, i) => strokeOutline(g, outlineOf(PART_SHAPES[n], poses[i], poses[i].a), colorFor('', 'player', isMe)));
        drawFace(g, head, head.a, body.facing);
      } else {
        const hat = id && !this.hatOff.has(id) ? this.hatOf(id) : 'none';
        // the gun: your own reload from your own clock (instant), everyone else's from the snapshot
        const gun = { ready: isMe ? this.net.readyShare(now) : readyShare(p.reload, GUN.reloadTicks), special: body.held ? SPECIAL_LOOK[body.held].color : null };
        const holes = id ? this.bodyHoles.get(id) : undefined;
        drawBody(g, { parts: poses, facing: body.facing, alive: body.alive, color: colorOfSlot(p.slot), headScale: view.headScale, hat, crown: body.crown, flash: id ? this.hitFx.flashOf(id) : undefined, gun, lost: p.lost, dents: p.dents, holes, melee: body.weapon === 'gun' ? undefined : body.weapon, broken: body.broken });
      }
      dustSamples.push({ id: String(p.slot), feet: feetOf(body.parts), grounded: body.grounded, alive: body.alive });
      // bars and name sit above the head (bigger in Big Head Mode)
      const top = { x: head.x, y: head.y - RAGDOLL.head.r * (view.headScale - 1) };
      if (id) tops.set(id, { x: top.x, y: top.y - 0.45 });
      if (body.alive) drawBars(g, top, body.hp / HEALTH.max, body.stamina / STAMINA.max, body.armsDown, body.protected);
      this.nameTag(p.slot, top, body.alive);
    }
    for (const [slot, t] of this.names) if (!seen.has(slot)) t.setVisible(false);

    this.updatePlaceholders(view, shapes, now);
    const hidden = new Set(this.placeholders.map((ph) => this.net.shotReplies.get(ph.seq)?.arrow).filter((id): id is number => id != null));
    this.holes.draw(g);
    for (const a of view.arrows) {
      if (hidden.has(a.id)) continue;
      if (a.kind) drawSpecialArrow(g, a.pose, a.pose.a, a.kind, !a.stuck, now);
      else drawBullet(g, a.pose, a.pose.a, colorOfSlot(a.ownerSlot));
    }
    this.flyingHats.draw(g, Math.min(deltaMs, 100) / 1000);
    for (const ph of this.placeholders) if (ph.flying) drawBullet(g, ph.pos, Math.atan2(ph.vel.y, ph.vel.x), colorOfSlot(this.mySlot), 0.8);
    if (!this.debugOn) for (const d of this.dust.update(dustSamples, now)) this.hitFx.puff(d.at, this.shown.arena.palette.dust, d.size, d.dir);
    this.hitFx.draw(g, Math.min(deltaMs, 100) / 1000);
    this.callouts.update((id) => tops.get(id) ?? null);

    let previewText = '';
    const mine = colorOfSlot(this.mySlot);
    if (aiming && me && melee && shoulder) drawReach(g, shoulder, intended!.angle, mine);
    else if (aiming && me && shot) {
      const preview = shot;
      drawPreview(g, preview.points, preview.hit?.point ?? null, this.debugOn, mine);
      for (const b of ('branches' in preview ? (preview.branches as Vec2[][]) : [])) drawPreview(g, b, null, false, mine);
      if (this.debugOn) previewText = `aim ${Math.round((aim!.angle * 180) / Math.PI)}deg -> ${preview.hit?.label ?? 'nothing'} in ${preview.ticks} ticks`;
    } else if (me && !me.alive) previewText = 'dead: wait to respawn';
    else if (me?.armsDown) previewText = `out of stamina: arms down until ${STAMINA.recoverAt}`;
    else if (me && me.fx & EFFECT_BIT.laugh) previewText = 'laughing too hard to shoot!';

    const roomNo = this.net.welcome.room.slice(1);
    // The match as the picture on screen shows it; timers count from the server's "now" (the picture is ~100 ms behind).
    const lines = [
      `Room ${roomNo}  you are ${this.net.nameOf(this.net.welcome.you)}  ping ${this.net.rttMs} ms   [mouse] aim  [click/hold] shoot  [A/D] walk  [W/Space] jump  [S] crouch  [T] taunt  [F2] debug`,
      matchLine(match, serverNow),
      ...(this.shareUrl && this.net.roster.filter((r) => !r.bot).length < 2 ? [`waiting for a friend: they open ${this.shareUrl} and join Room ${roomNo}`] : []),
      'score  ' +
        [...view.players]
          .sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths)
          .map((p) => `${p.crown ? '[CROWN] ' : ''}${this.nameForSlot(p.slot)} ${p.score}`)
          .join('   '),
    ];
    if (me && !me.alive) lines.push(`you died - back in about ${(RESPAWN.delayTicks / 60).toFixed(0)} s`);
    if (me?.alive && gloves) lines.push(`NEXT ROUND: Boxing glove (${MODIFIER_NAMES.glove_only})${me.held ? `, then ${SPECIAL_LOOK[me.held].name}` : ''}`);
    else if (me?.alive && me.held) lines.push(`NEXT ROUND: ${SPECIAL_LOOK[me.held].name}`);
    if (me?.alive && me.fx & EFFECT_BIT.pinned) lines.push('PINNED! mash JUMP to break free');
    if (me?.alive && melee) lines.push(`GUN KNOCKED AWAY: ${melee.toUpperCase()} - click to swing (you run faster, bullets hurt less) until you die`);
    // L4: what's broken (an apple fixes it)
    const brokenLimbs = me ? PART_NAMES.filter((_, i) => me.broken & (1 << i)).map((n) => (n.startsWith('arm') ? 'arm' : 'leg')) : [];
    const hurt = [
      me?.legStage ? `legs: ${LEG_STAGE_NAMES[me.legStage].replace('_', ' ')}` : '',
      brokenLimbs.length ? `broken ${brokenLimbs.join(' + ')} (hits hurt ${Math.round((MELEE.brokenDamage - 1) * 100)}% more)` : '',
    ].filter(Boolean);
    if (me?.alive && hurt.length) lines.push(`${hurt.join(', ')} - a red apple puts you back together`);
    if (this.debugOn) {
      const s = this.net.buffer.stats;
      lines.push(
        `render tick ${renderTick.toFixed(1)}  newest ${fresh.tick}  buffered ${this.net.buffer.depth(now)}  underruns ${s.underruns}  worst gap ${Math.round(s.maxGapMs)} ms  fps ${Math.round(this.game.loop.actualFps)}`,
      );
    }
    if (previewText) lines.push(previewText);
    const enemies = view.players.filter((p) => p.slot !== this.mySlot && p.alive).map((p) => ({ at: p.parts[TORSO], color: colorOfSlot(p.slot) }));
    const banner = matchBanner(match, serverNow, (id) => this.net.nameOf(id));
    const headline = modifierHeadline(match, serverNow);
    const pointer = this.input2.pointer;
    const reticle = pointer ? { at: pointer, ready: this.net.readyShare(now), color: mine, blocked: this.gunBlocked(me) } : null;
    this.hud.render({ lines, reticle, offscreen: this.camera.offscreen(enemies), banner, headline });
  }

  /** Gun arm part pose when pointing along the aim (upper arm center 0.2 m out, lower 0.6 m). */
  private aimedArmPose(p: NetPlayer, aim: Aim, along: number) {
    const s = shoulderFrontFrom(p.parts[TORSO], p.parts[TORSO].a);
    return { x: s.x + Math.cos(aim.angle) * along, y: s.y + Math.sin(aim.angle) * along, a: aim.angle - Math.PI / 2 };
  }

  /** Stand-in bullets fly locally until the server's bullet for the same shot shows up, then hand over. */
  private updatePlaceholders(view: SnapshotData, shapes: PlacedShape[], now: number): void {
    this.placeholders = this.placeholders.filter((ph) => {
      const reply = this.net.shotReplies.get(ph.seq);
      if (reply && reply.arrow === null) {
        this.log.info('shot_refused', { seq: ph.seq, reason: reply.reason });
        return false;
      }
      const real = reply && view.arrows.find((a) => a.id === reply.arrow);
      if (real) {
        this.log.info('placeholder_handover', { seq: ph.seq, arrow: reply!.arrow, gapM: r2(Math.hypot(real.pose.x - ph.pos.x, real.pose.y - ph.pos.y)), afterMs: Math.round(now - ph.born) });
        this.net.shotReplies.delete(ph.seq);
        return false;
      }
      // L3: a short shot can hit and vanish between two snapshots, so the real bullet may never be seen: once the
      // stand-in has landed too and the server said the shot went out, it's done.
      if (reply && !ph.flying) {
        this.log.info('placeholder_landed', { seq: ph.seq, arrow: reply.arrow, afterMs: Math.round(now - ph.born) });
        this.net.shotReplies.delete(ph.seq);
        return false;
      }
      // The real bullet already hit something (e.g. a player who moved into it while the stand-in flew past): a
      // snapshot sent after the shot doesn't have it. (The reply comes before any snapshot sent after the shot, so
      // one snapshot gap past the newest one then is surely after it.)
      if (reply && view.tick >= reply.newest + NET.snapshotEveryTicks) {
        this.log.info('placeholder_gone', { seq: ph.seq, arrow: reply.arrow, afterMs: Math.round(now - ph.born), standInFlying: ph.flying });
        this.net.shotReplies.delete(ph.seq);
        return false;
      }
      if (now - ph.born > PLACEHOLDER_MAX_MS) {
        this.log.warn('placeholder_timeout', { seq: ph.seq, replied: !!reply });
        return false;
      }
      while (ph.flying && now - ph.lastStepAt >= 1000 / 60) {
        const next = stepArrow(ph.pos, ph.vel, DT, this.wind(ph.pos));
        const hit = raycastShapes(ph.pos, next.pos, shapes);
        ph.lastStepAt += 1000 / 60;
        if (hit) {
          ph.pos = hit.point;
          ph.flying = false; // (L3: a bullet vanishes where it hits; kept until the server's answer for the log)
        } else [ph.pos, ph.vel] = [next.pos, next.vel];
      }
      return true;
    });
  }

  /** Display name; bots are marked so nobody mistakes them for a person. */
  private nameForSlot(slot: number): string {
    const r = this.net.roster.find((e) => e.slot === slot);
    return r ? `${r.name}${r.bot ? ' (bot)' : ''}` : `slot${slot}`;
  }

  private nameTag(slot: number, head: Vec2, alive: boolean): void {
    let t = this.names.get(slot);
    if (!t) {
      t = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '12px', color: '#e3e9ee', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5, 1);
      this.names.set(slot, t);
    }
    t.setText(this.nameForSlot(slot)).setPosition(px(head.x), px(head.y - 0.45) - 16).setVisible(alive);
  }
}
