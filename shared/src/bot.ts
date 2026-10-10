import { solveAim, type Aim } from './aim';
import { PIT_KILL_BELOW } from './arena';
import { BOT, GUN, MELEE } from './constants';
import { dist, r2, r3 } from './math';
import { launchPointFrom } from './ragdoll';
import type { GameWorld } from './world';

/**
 * What a bot "presses": exactly the messages a browser sends (minus seq), so the server checks bots like any player.
 * `aim` = the gun's angle while aiming at someone (null: the gun points ahead). `swing`: only with a hit arm.
 */
export type BotAction =
  | { t: 'input'; aim: number | null; crouch: boolean; jump: boolean; move: -1 | 0 | 1 }
  | { t: 'fire'; angle: number; swing?: number };

/** How many filler bots a room wants: enough to reach `fillTo` players (M1: a room may want fewer), none once people fill it. */
export function botsWanted(humans: number, fillTo: number = BOT.fillTo): number {
  return humans > 0 ? Math.max(0, fillTo - humans) : 0;
}

/** M1: a room's bot level (not 'off'). */
export type BotSkill = keyof typeof BOT.levels;

/** Small seeded random number generator (same seed = same bot behavior, so sim runs repeat exactly). */
export function seededRandom(seed: number): () => number {
  let s = Math.abs(Math.floor(seed)) % 2147483646 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * Where the body's lowest sole is (y down): the bottom of a shin, or of a thigh stump. The look-ahead rays are measured
 * from here: a fixed height under the torso was 0.65 m too low on two stumps (their torso is ~0.75 m up, not 1.4), so
 * the knee ray started underground (a "step" every tick: a jump on every landing) and a 1 m step read as 0.35 m.
 */
function soleY(world: GameWorld, id: string): number {
  return Math.max(...world.player(id).footPoints().map((f) => f.y));
}

/**
 * A filler bot's brain. Each tick it looks at the world and decides what to press:
 * walk for a bit, then pick the nearest enemy, aim at them for a moment (reaction time), and fire with some aim error
 * each time the gun is reloaded (L3); sometimes it keeps shooting, sometimes it walks on. Low on stamina it stops
 * shooting until it's back. It aims with the same preview players see (`previewShot`) and its shots go through the same
 * checks as a person's (reload, stamina), so it can't do anything a person can't. `BOT.aimError` keeps it beatable.
 */
export class BotBrain {
  private readonly rand: () => number;
  private mode: 'move' | 'aim' = 'move';
  private until = 0;
  private move: -1 | 0 | 1 = 0;
  private target: string | null = null;
  private aimStart = 0;
  private aim: Aim | null = null;
  /** Which arc the current aim is (how far from the flat shot toward the lob), to follow a moving target. */
  private arc = { k: 0 };
  /** Low on stamina from shooting: no shots until it's back to BOT.restUntil. */
  private tired = false;
  /**
   * After turning around at an obstacle (a wall, a pit, stuck): don't walk that way again until this tick. One per
   * direction: a single shared slot forgot the wall behind as soon as the step ahead blocked too, so a bot boxed in
   * between them walked back and forth forever (sim stump_survival: two stumps between Test Lab's wall and 1 m step).
   */
  private blockedUntil = { left: -Infinity, right: -Infinity };
  /** For the stuck anomaly: ticks spent trying to walk without getting 1 m anywhere. */
  private noProgress = { x: 0, ticks: 0 };
  private lastInput = '';
  /** A jump is held until this tick (L2: a one-tick tap is only a short hop; bots want full jumps to climb steps). */
  private jumpUntil = -Infinity;
  private now = 0;
  /** Progress check while walking: where we were, since when. */
  private stuck = { x: 0, dir: 0, since: 0, tries: 0 };

  private readonly aimError: number;
  private readonly aimTicks: [number, number];

  constructor(
    readonly id: string,
    seed: number,
    readonly skill: BotSkill = 'normal',
  ) {
    const lvl = BOT.levels[skill];
    this.aimError = BOT.aimError * lvl.aimErrorScale;
    this.aimTicks = [Math.round(BOT.aimTicks[0] * lvl.aimTicksScale), Math.round(BOT.aimTicks[1] * lvl.aimTicksScale)];
    this.rand = seededRandom(seed);
  }

  /** Call once per tick, before the world steps. Returns what to send this tick (usually nothing or one input). */
  think(world: GameWorld): BotAction[] {
    const me = world.players.get(this.id);
    const st = world.stats.get(this.id);
    if (!me || !st) return [];
    const tick = world.tick;
    this.now = tick;
    if (!st.alive || world.frozen) {
      this.mode = 'move';
      this.until = tick;
      return this.input(null, 0, false);
    }
    if (world.melee.weaponOf(this.id) !== 'gun') return this.brawl(world, tick);
    const out: BotAction[] = [];
    if (this.tired && st.stamina >= BOT.restUntil) this.tired = false;
    if (this.mode === 'aim') {
      const target = this.target ? world.players.get(this.target) : undefined;
      if (!target || !world.stats.get(this.target!)?.alive || st.armsDown) {
        this.startMoving(world, tick);
      } else {
        if ((tick - this.aimStart) % 10 === 0) this.aim = this.followAim(world, this.target!) ?? this.aim;
        const aim = this.aim!;
        if (tick >= this.until && st.reloadLeft(tick) === 0) {
          const angle = aim.angle + this.gauss() * this.aimError;
          out.push({ t: 'fire', angle: r3(angle) });
          const after = st.stamina - Math.min(st.stamina, GUN.staminaPerShot);
          world.log.info('bot_fire', { id: this.id, target: this.target, errDeg: Math.round(((angle - aim.angle) * 180) / Math.PI), stamina: Math.round(after) });
          if (after < BOT.restBelow) {
            this.tired = true;
            world.log.info('bot_rest', { id: this.id, why: 'shots', stamina: Math.round(after) });
          }
          if (!this.tired && this.rand() < BOT.keepShooting) {
            this.until = tick + GUN.reloadTicks; // the same target again, as soon as the gun is ready
            return out;
          }
          this.startMoving(world, tick);
          out.push(...this.input(null, this.move, false));
          return out;
        }
        return this.input(aim.angle, 0, false);
      }
    }
    if (tick >= this.until) this.decide(world, tick);
    this.move = this.avoidPit(world, this.move);
    const jump = this.lookAhead(world) || this.checkStuck(world, tick);
    return this.input(null, this.move, jump);
  }

  // ---- internals ----

  /**
   * L5: the gun was knocked away: walk at the nearest enemy and swing the bat/mace when they're in reach (the same
   * fire message as a shot; the server swings it and decides the hit). Until death: then it has the gun again.
   */
  private brawl(world: GameWorld, tick: number): BotAction[] {
    this.mode = 'move';
    this.target = null;
    const st = world.playerStats(this.id);
    const enemy = this.nearestEnemy(world);
    if (!enemy) {
      if (tick >= this.until) this.decide(world, tick);
      return this.input(null, this.avoidPit(world, this.move), this.lookAhead(world) || this.checkStuck(world, tick));
    }
    const shoulder = world.player(this.id).jointPos('shoulderFront');
    const at = world.player(enemy).center();
    const d = dist(shoulder, at);
    const angle = Math.atan2(at.y - shoulder.y, at.x - shoulder.x);
    if (d <= MELEE.reach * BOT.meleeReachShare && !st.armsDown && st.fireBlock(tick) === null) {
      const swingAt = angle + this.gauss() * this.aimError;
      world.log.info('bot_swing', { id: this.id, target: enemy, d: r2(d) });
      return [{ t: 'fire', angle: r3(swingAt) }, ...this.input(angle, 0, false)];
    }
    // Close in (stop when right on top of them); aim at them when near, so the body faces them. A wall that way not
    // long ago (lookAhead / checkStuck turned around): keep going the other way until that runs out, to get round.
    const dx = at.x - shoulder.x;
    const want: -1 | 0 | 1 = Math.abs(dx) > MELEE.reach * 0.5 ? (Math.sign(dx) as -1 | 1) : 0;
    this.move = this.avoidPit(world, this.steer(world, want));
    const jump = this.lookAhead(world) || this.checkStuck(world, tick) || (at.y < shoulder.y - 1.2 && Math.abs(dx) < 3);
    return this.input(d < 4 ? angle : null, this.move, jump);
  }

  /** Picks what to do next: aim at a target if there's a clear shot, else walk. Returns the new mode. */
  private decide(world: GameWorld, tick: number): 'move' | 'aim' {
    const target = this.nearestEnemy(world);
    const me = world.player(this.id).center();
    const st = world.playerStats(this.id);
    if (target && !st.armsDown && !this.tired && dist(me, world.player(target).center()) <= BOT.maxShotRange) {
      const aim = this.findAim(world, target);
      if (aim) {
        this.mode = 'aim';
        this.target = target;
        this.aim = aim;
        this.aimStart = tick;
        this.until = tick + this.between(this.aimTicks);
        return 'aim';
      }
    }
    // No clear shot: walk toward the target (or wander if there's none).
    const dx = target ? world.player(target).center().x - me.x : 0;
    const want = target && Math.abs(dx) > 2 && this.rand() < 0.75 ? (Math.sign(dx) as -1 | 1) : ([-1, 0, 1] as const)[Math.floor(this.rand() * 3)];
    this.move = this.steer(world, want); // not a way that was blocked not long ago
    this.until = tick + this.between(BOT.moveTicks);
    // (the stuck timer is NOT reset here: new decisions come faster than it reacts; only real movement resets it)
    return 'move';
  }

  private startMoving(world: GameWorld, tick: number): void {
    this.mode = 'move';
    this.target = null;
    this.aim = null;
    if (this.decide(world, tick) === 'aim') {
      // after walking away from a target, walk a little before picking one again
      this.mode = 'move';
      this.move = ([-1, 1] as const)[Math.floor(this.rand() * 2)];
      this.until = tick + this.between(BOT.moveTicks);
    }
  }

  private nearestEnemy(world: GameWorld): string | null {
    const me = world.player(this.id).center();
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, p] of world.players) {
      if (id === this.id || !world.stats.get(id)?.alive || world.sameTeam(this.id, id)) continue;
      const d = dist(me, p.center());
      if (d < bestD) [best, bestD] = [id, d];
    }
    return best;
  }

  /**
   * An aim whose preview (the same one players see) hits the target. Tries arcs from the flat shot up to the lob (one
   * bullet speed: L3), so it finds the gap over a wall but under a platform. Flatter (faster) shots first.
   */
  private findAim(world: GameWorld, target: string): Aim | null {
    for (let i = 0; i <= BOT.aimArcSteps; i++) {
      const k = i / BOT.aimArcSteps;
      const aim = this.arcAim(world, target, k);
      if (aim && this.previewHits(world, target, aim)) {
        this.arc = { k };
        return aim;
      }
    }
    return null;
  }

  /** While aiming: the same arc toward where the target is now, if it still hits; else null (keep the old aim). */
  private followAim(world: GameWorld, target: string): Aim | null {
    const aim = this.arcAim(world, target, this.arc.k);
    return aim && this.previewHits(world, target, aim) ? aim : null;
  }

  /** The aim `k` of the way from the flat shot (0) to the lob (1), or null if out of reach. */
  private arcAim(world: GameWorld, target: string, k: number): Aim | null {
    const shoulder = world.player(this.id).jointPos('shoulderFront');
    const to = world.player(target).center();
    const solve = (high: boolean) => {
      const a = solveAim(shoulder, to, GUN.bulletSpeed, high);
      // The bullet starts at the gun hand, not the shoulder: solve once more from there.
      return a === null ? null : (solveAim(launchPointFrom(shoulder, { angle: a }), to, GUN.bulletSpeed, high) ?? a);
    };
    const low = solve(false);
    const high = solve(true);
    if (low === null || high === null) return null;
    return { angle: low + (high - low) * k };
  }

  private previewHits(world: GameWorld, target: string, aim: Aim): boolean {
    return !!world.previewShot(this.id, aim).hit?.label.startsWith(`${target}:`);
  }

  /**
   * What's right ahead while walking: a step (low block: jump it, from standing if close) or a wall
   * (too tall: turn around). Two short rays: one at knee height, one just above a jumpable step.
   */
  private lookAhead(world: GameWorld): boolean {
    if (!this.move) return false;
    const p = world.player(this.id);
    if (!p.grounded) return false;
    const c = p.center();
    const feetY = soleY(world, this.id);
    const solidAhead = (height: number, reach: number) => {
      const from = { x: c.x, y: feetY - height };
      const hit = world.raycast(from, { x: c.x + this.move * reach, y: from.y }, this.id);
      return hit && !hit.label.includes(':') ? Math.abs(hit.point.x - c.x) : null; // players and apples don't block
    };
    const low = solidAhead(BOT.kneeHeight, BOT.lookAhead);
    if (low === null) return false;
    // (two stumps jump much lower: a step a whole body hops is a wall for them; sim jump_reach measures both)
    if (solidAhead(p.legsLeft === 0 ? BOT.maxStepUpStumps : BOT.maxStepUp, BOT.lookAhead) !== null) {
      // a wall: don't walk into it
      this.move = this.block(world, this.move, 'wall');
      return false;
    }
    // L6: a step up to BOT.maxStepUp is climbed from standing (sim jump_reach: 1.4 m with no run-up), so close to it a
    // slow bot just jumps; backing up for a run-up flip-flopped forever in a 2 m pocket against a wall (narrow Test Lab)
    if (Math.abs(p.speedX()) >= BOT.jumpSpeedNeeded || low <= BOT.standJumpWithin) return true; // (L7: jumps are free)
    return false;
  }

  /**
   * Don't walk into a pit: turn around near the edge (only at ground level; bridges above are fine). L6: unless there's
   * something to walk on right ahead, over the pit (a plank or a bridge at that level: a ray straight down finds it),
   * so bots cross Windy Rooftop's plank (its only crossing) instead of turning back at the alley forever.
   */
  private avoidPit(world: GameWorld, move: -1 | 0 | 1): -1 | 0 | 1 {
    if (!move) return move;
    const c = world.player(this.id).center();
    const ahead = c.x + move * BOT.pitMargin;
    for (const p of world.arena?.pits ?? []) {
      const groundTop = p.y - PIT_KILL_BELOW;
      const atGround = c.y > groundTop - 3 && c.y < groundTop;
      if (!atGround || ahead <= p.x || ahead >= p.x + p.w) continue;
      // (two looks, 0.75 m apart: a stride steps over a small gap, like the 0.5 m between a roof and the plank)
      const feetY = soleY(world, this.id);
      const floorAt = (x: number) => {
        const hit = world.raycast({ x, y: feetY - 0.5 }, { x, y: groundTop + 0.5 }, this.id);
        return !!hit && !hit.label.includes(':') && hit.point.y < groundTop;
      };
      if (floorAt(ahead) || floorAt(ahead + move * 0.75)) continue; // a plank / bridge: walk on
      // L7: remember the pit like a wall. Without it, a bot whose target stood across a gap (and had no clear shot)
      // turned back here, then decided to walk at the target again a moment later: back and forth at the edge for
      // 5 s (sim arena_fights, windy_rooftop, bot_stuck).
      this.move = this.block(world, move, 'pit');
      return this.move;
    }
    return move;
  }

  /**
   * Walking but not getting anywhere (a step, a crate, a wall): jump; still stuck: turn around, and remember
   * not to walk that way for a while.
   * A bot that could jump but keeps wanting to walk without getting 1 m anywhere is an anomaly (a brain bug).
   */
  private checkStuck(world: GameWorld, tick: number): boolean {
    const p = world.player(this.id);
    const x = p.center().x;
    const able = !p.down; // could jump right now (L7: jumps are free)
    if (this.move && able) {
      if (Math.abs(x - this.noProgress.x) > 1) this.noProgress = { x, ticks: 0 };
      else if (++this.noProgress.ticks === BOT.stuckAnomalyTicks) world.anomaly('bot_stuck', this.id, { at: r2(x), move: this.move, ticks: this.noProgress.ticks });
    }
    if (!this.move || this.move !== this.stuck.dir || Math.abs(x - this.stuck.x) > BOT.stuckDist) {
      this.stuck = { x, dir: this.move, since: tick, tries: 0 };
      return false;
    }
    if (tick - this.stuck.since < BOT.stuckTicks) return false;
    this.stuck.since = tick;
    this.stuck.tries++;
    if (this.stuck.tries % 2 === 1) return true; // first try: jump
    this.move = this.block(world, this.move, 'stuck');
    return false;
  }

  private isBlocked(dir: -1 | 1): boolean {
    return this.now < this.blockedUntil[dir < 0 ? 'left' : 'right'];
  }

  /** The way to walk instead of `want`: the other way if `want` was blocked not long ago; 0 if both were (boxed in). */
  private steer(world: GameWorld, want: -1 | 0 | 1): -1 | 0 | 1 {
    if (!want || !this.isBlocked(want)) return want;
    return this.isBlocked((-want) as -1 | 1) ? this.boxedIn(world) : ((-want) as -1 | 1);
  }

  /** Can't go `dir` (a wall, a pit, stuck): remember it for BOT.avoidTicks and turn around, or stop if that way is blocked too. */
  private block(world: GameWorld, dir: -1 | 1, why: 'wall' | 'pit' | 'stuck'): -1 | 0 | 1 {
    if (!this.isBlocked(dir)) world.log.info('bot_turn', { id: this.id, at: r2(world.player(this.id).center().x), blockedDir: dir, why });
    this.blockedUntil[dir < 0 ? 'left' : 'right'] = this.now + BOT.avoidTicks;
    return this.steer(world, dir);
  }

  /**
   * Blocked both ways (e.g. two stumps in a pocket between a wall and a step they can't jump): stand and fight from
   * here instead of walking back and forth; try again when the older block runs out (things change: a crate moves).
   * A choice, not a brain bug: the stuck anomaly starts counting afresh.
   */
  private boxedIn(world: GameWorld): 0 {
    if (this.move !== 0) {
      const { left, right } = this.blockedUntil;
      world.log.info('bot_boxed_in', { id: this.id, at: r2(world.player(this.id).center().x), legsLeft: world.player(this.id).legsLeft, retryIn: Math.min(left, right) - this.now });
    }
    this.noProgress.ticks = 0;
    return 0;
  }

  /**
   * Sends an input only when it changes (like the browser does). A jump press is held for BOT.jumpHoldTicks (a full
   * jump), whatever the bot decides meanwhile.
   */
  private input(aim: number | null, move: -1 | 0 | 1, wantJump: boolean): BotAction[] {
    if (wantJump && this.now >= this.jumpUntil) this.jumpUntil = this.now + BOT.jumpHoldTicks;
    const jump = this.now < this.jumpUntil;
    const a = aim === null ? null : r3(aim);
    const key = JSON.stringify([a, move, jump]);
    if (key === this.lastInput) return [];
    this.lastInput = key;
    return [{ t: 'input', aim: a, crouch: false, jump, move }];
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }

  /** Normal-distributed random number (mean 0, deviation 1). */
  private gauss(): number {
    const u = Math.max(1e-9, this.rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }
}
