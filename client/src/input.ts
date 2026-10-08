import Phaser from 'phaser';
import { aimAt, PX_PER_M, r3, type Aim, type Controls, type Logger, type Vec2 } from '@ragdoll/shared';

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SPACE' | 'T', Phaser.Input.Keyboard.Key>;

/**
 * L3 gun controls: the gun points at the mouse pointer (only the direction counts); click to fire, hold to keep
 * firing each time it's reloaded. Keys walk, jump and crouch. Used by both the offline and the online scene.
 */
export class PlayerInput {
  /** Where the pointer is on the screen (px), or null before it was ever moved over the game. */
  pointer: Vec2 | null = null;
  /** The fire button is held down. */
  private held = false;
  /** A press seen since the last `trigger()`: a click that goes down and up between two frames still fires. */
  private pressed = false;
  private readonly keys: Keys;
  /** Key presses seen since the last frame. Phaser forgets a tap that goes down and up between two frames. */
  private tapped = { jump: false, crouch: false };

  constructor(private readonly scene: Phaser.Scene) {
    const at = (p: Phaser.Input.Pointer) => {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) this.pointer = { x: p.x, y: p.y };
    };
    scene.input.on('pointermove', at);
    scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      at(p);
      this.held = true;
      this.pressed = true;
    });
    scene.input.on('pointerup', () => (this.held = false));
    scene.input.on('gameout', () => (this.held = false)); // released outside the canvas: no stuck trigger
    scene.input.setDefaultCursor('crosshair');
    const kb = scene.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,T') as Keys;
    for (const key of ['W', 'UP', 'SPACE']) kb.on(`keydown-${key}`, () => (this.tapped.jump = true));
    for (const key of ['S', 'DOWN']) kb.on(`keydown-${key}`, () => (this.tapped.crouch = true));
  }

  /** The pointer in the world (m), through the scene's camera as it is now. */
  pointerWorld(): Vec2 | null {
    if (!this.pointer) return null;
    const w = this.scene.cameras.main.getWorldPoint(this.pointer.x, this.pointer.y);
    return { x: w.x / PX_PER_M, y: w.y / PX_PER_M };
  }

  /** The aim from your shoulder (m) to the pointer; null before the pointer was ever over the game. */
  aimFrom(shoulder: Vec2): Aim | null {
    const to = this.pointerWorld();
    const aim = to ? aimAt(shoulder, to) : null;
    // (a hidden or zero-size canvas gives NaN coordinates: no aim rather than a broken one)
    return aim && Number.isFinite(aim.angle) ? aim : null;
  }

  /** Does the player want a shot now? (held, or clicked since the last call). Call once per frame. */
  trigger(): boolean {
    const want = this.held || this.pressed;
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
