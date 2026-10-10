import Phaser from 'phaser';
import { AIM_POINT, aimAlong, moveAimPoint, r3, type Aim, type Controls, type Logger, type Vec2 } from '@ragdoll/shared';
import { CAMERA } from './camera';

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SPACE' | 'T', Phaser.Input.Keyboard.Key>;

/**
 * Gun controls (L7: character-relative aim): mouse movement moves an aim point attached to your shoulder (see
 * `moveAimPoint`); the gun points at it, so walking and the camera never change your aim. A click locks the mouse to
 * the game (pointer lock; Esc frees it) and fires; hold to keep firing each time it's reloaded. No cursor: a faint dot
 * marks the aim point. Keys walk, jump and crouch. Used by both the offline and the online scene.
 */
export class PlayerInput {
  /** The aim point: offset from your shoulder (m), or null before the mouse ever moved over the game. */
  offset: Vec2 | null = null;
  /** Mouse movement (m) not yet applied to the aim point (it starts ahead of you, which needs your facing). */
  private pending = { x: 0, y: 0, any: false };
  /** The mouse is locked to the game (pointer lock). */
  private locked = false;
  /** For the perf report: turn-arounds (the point crossing your body) and the aim distance, since the last report. */
  private stats = { turns: 0, distSum: 0, frames: 0, atMax: 0, badMoves: 0 };
  /** The fire button is held down. */
  private held = false;
  /** A press seen since the last `trigger()`: a click that goes down and up between two frames still fires. */
  private pressed = false;
  private readonly keys: Keys;
  /** Key presses seen since the last frame. Phaser forgets a tap that goes down and up between two frames. */
  private tapped = { jump: false, crouch: false };

  constructor(
    scene: Phaser.Scene,
    private readonly log: Logger,
  ) {
    const canvas = scene.game.canvas;
    // Raw mouse movement (works both locked and unlocked). CSS px -> m: as far as a cursor would move over the world.
    const onMove = (e: MouseEvent) => {
      const dx = e.movementX;
      const dy = e.movementY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        this.stats.badMoves++;
        return;
      }
      const w = canvas.clientWidth;
      if (!(w > 0)) return; // hidden or zero-size canvas
      const k = (CAMERA.viewWidth / w) * AIM_POINT.sensitivity;
      this.pending.x += dx * k;
      this.pending.y += dy * k;
      this.pending.any = true;
    };
    canvas.addEventListener('mousemove', onMove);
    const onLock = () => {
      const locked = document.pointerLockElement === canvas;
      if (locked === this.locked) return;
      this.locked = locked;
      this.log.info('aim_lock', { on: locked });
    };
    document.addEventListener('pointerlockchange', onLock);
    document.addEventListener('pointerlockerror', () => this.log.info('aim_lock_refused', {}));
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      canvas.removeEventListener('mousemove', onMove);
      document.removeEventListener('pointerlockchange', onLock);
    });
    scene.input.on('pointerdown', () => {
      // (newer browsers answer with a promise that rejects when the lock is refused, e.g. right after Esc: aiming
      // still works unlocked, so it's only logged)
      if (!this.locked) {
        const req = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        req?.catch?.((e: unknown) => this.log.info('aim_lock_refused', { why: String(e).slice(0, 80) }));
      }
      this.held = true;
      this.pressed = true;
    });
    scene.input.on('pointerup', () => (this.held = false));
    scene.input.on('gameout', () => (this.held = false)); // released outside the canvas: no stuck trigger
    // L7: no cursor over the game: the gun, its aim preview and a faint dot show where you aim
    scene.input.setDefaultCursor('none');
    const kb = scene.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,T') as Keys;
    for (const key of ['W', 'UP', 'SPACE']) kb.on(`keydown-${key}`, () => (this.tapped.jump = true));
    for (const key of ['S', 'DOWN']) kb.on(`keydown-${key}`, () => (this.tapped.crouch = true));
  }

  /**
   * This frame's aim: applies the mouse movement to the aim point and points from the shoulder toward it. `facing`:
   * where you face now (the point starts ahead of you). Null before the mouse ever moved. Call once per frame.
   */
  aimFrom(facing: number): Aim | null {
    if (this.pending.any) {
      const before = this.offset ?? { x: (facing < 0 ? -1 : 1) * AIM_POINT.start, y: 0 };
      this.offset = moveAimPoint(before, this.pending.x, this.pending.y);
      if (Math.sign(this.offset.x) !== Math.sign(before.x) && this.offset.x !== 0) this.stats.turns++;
      this.pending = { x: 0, y: 0, any: false };
    }
    if (!this.offset) return null;
    const d = Math.hypot(this.offset.x, this.offset.y);
    this.stats.distSum += d;
    this.stats.frames++;
    if (d > AIM_POINT.maxDistance - 0.01) this.stats.atMax++;
    return aimAlong(this.offset);
  }

  /** Where the aim point is in the world (m), for the dot; null before the mouse moved. */
  aimPoint(shoulder: Vec2): Vec2 | null {
    return this.offset ? { x: shoulder.x + this.offset.x, y: shoulder.y + this.offset.y } : null;
  }

  /** Aim numbers for the perf report (then reset): turn-arounds, average and at-the-limit share of the aim distance. */
  aimReport(): Record<string, unknown> {
    const s = this.stats;
    const out = { aimTurns: s.turns, aimDist: s.frames ? r3(s.distSum / s.frames) : null, aimAtMax: s.frames ? r3(s.atMax / s.frames) : null, locked: this.locked, ...(s.badMoves ? { badMoves: s.badMoves } : {}) };
    this.stats = { turns: 0, distSum: 0, frames: 0, atMax: 0, badMoves: 0 };
    return out;
  }

  /**
   * Does the player want a shot now? (held, or clicked since the last call). Call once per frame. `repeat` false
   * (L7 melee): only a click counts, so one click = one swing (holding doesn't keep swinging).
   */
  trigger(repeat = true): boolean {
    const want = (repeat && this.held) || this.pressed;
    this.pressed = false;
    return want;
  }

  /** This frame's controls (`aim`: from `aimFrom`). Call once per frame (it clears the remembered taps). */
  read(aim: Aim | null): Controls {
    const k = this.keys;
    const left = k.A.isDown || k.LEFT.isDown;
    const right = k.D.isDown || k.RIGHT.isDown;
    const c: Controls = {
      aim,
      crouch: this.tapped.crouch || k.S.isDown || k.DOWN.isDown,
      jump: this.tapped.jump || k.W.isDown || k.UP.isDown || k.SPACE.isDown,
      move: left === right ? 0 : left ? -1 : 1,
      // T: taunt (a silly dance; getting hit mid-dance is HUMBLED!)
      taunt: k.T.isDown,
    };
    this.tapped = { jump: false, crouch: false };
    return c;
  }
}

const PERF_REPORT_MS = 5000;
const LOW_FPS = 45;

/** Logs fps every 5 s (warn if low). */
export class PerfTracker {
  private p = { since: 0, frames: 0, steps: 0, worstFrameMs: 0 };

  constructor(private readonly log: Logger) {}

  frame(time: number, deltaMs: number, steps: number, extra?: () => Record<string, unknown>): void {
    const p = this.p;
    if (!p.since) p.since = time;
    p.frames++;
    p.steps += steps;
    p.worstFrameMs = Math.max(p.worstFrameMs, deltaMs);
    const elapsed = time - p.since;
    if (elapsed < PERF_REPORT_MS) return;
    const fps = r3((p.frames * 1000) / elapsed);
    const data = { fps, stepsPerSec: r3((p.steps * 1000) / elapsed), worstFrameMs: Math.round(p.worstFrameMs), ...extra?.() };
    if (fps < LOW_FPS) this.log.warn('low_fps', data);
    else this.log.debug('perf', data);
    this.p = { since: time, frames: 0, steps: 0, worstFrameMs: 0 };
  }
}
