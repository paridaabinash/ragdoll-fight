import Phaser from 'phaser';
import { CALLOUT_SIZE, type CalloutKind, type Logger, type Vec2 } from '@ragdoll/shared';
import { px } from './draw';
import type { HudScene } from './hud';

/** Each callout keeps its own text colours (easy to tell apart); no shapes behind them (L1). `size`: banner font px. */
export const CALLOUT_STYLE: Record<CalloutKind, { text: string; fill: string; stroke: string; size: number }> = {
  cracked: { text: 'CRACKED!', fill: '#ffd600', stroke: '#000000', size: 30 },
  ankle_breaker: { text: 'ANKLE BREAKER!', fill: '#4fc3f7', stroke: '#000000', size: 24 },
  airball: { text: 'AIRBALL!', fill: '#ffffff', stroke: '#000000', size: 28 },
  sniped: { text: 'SNIPED!', fill: '#ff5252', stroke: '#000000', size: 30 },
  point_blank: { text: 'POINT BLANK!', fill: '#ff9100', stroke: '#000000', size: 24 },
  ring_out: { text: 'RING OUT!', fill: '#ff3d00', stroke: '#000000', size: 34 },
  // S5
  outta_here: { text: 'OUTTA HERE!', fill: '#ffffff', stroke: '#b71c1c', size: 38 },
  splat: { text: 'SPLAT!', fill: '#ffffff', stroke: '#000000', size: 34 },
  slip: { text: "SLIP 'N SLIDE!", fill: '#c6ff00', stroke: '#000000', size: 28 },
  pinned: { text: 'PINNED!', fill: '#b0bec5', stroke: '#000000', size: 28 },
  swapped: { text: 'SWAPPED!', fill: '#b388ff', stroke: '#000000', size: 26 },
  tickled: { text: 'HA HA HA!', fill: '#ffffff', stroke: '#000000', size: 24 },
  kaboom: { text: 'KABOOM!', fill: '#ffea00', stroke: '#bf360c', size: 38 },
  disarmed: { text: 'DISARMED!', fill: '#ff9100', stroke: '#000000', size: 38 },
  leg_off: { text: 'LEG OFF!', fill: '#ff4f81', stroke: '#000000', size: 38 },
  shattered: { text: 'SHATTERED!', fill: '#e1f5fe', stroke: '#4a148c', size: 40 },
  // S6
  bonk: { text: 'BONK!', fill: '#cfd8dc', stroke: '#000000', size: 34 },
  // S7
  revenge: { text: 'REVENGE!', fill: '#ff5252', stroke: '#000000', size: 30 },
  double_kill: { text: 'DOUBLE KILL', fill: '#ffea00', stroke: '#4a148c', size: 36 },
  self_own: { text: 'SELF-OWN!', fill: '#ffffff', stroke: '#000000', size: 32 },
  humbled: { text: 'HUMBLED!', fill: '#ff80ab', stroke: '#000000', size: 30 },
};

/** Callout timing and sizes (L1). */
export const CALLOUT_LOOK = {
  /** Small tags: 60% of the old banner size, slightly bigger for harder hits. */
  tag: { scale: 0.6, ms: 600, popMs: 90, fadeMs: 200 },
  /** Big banners: at the top of the screen, at most this many waiting behind the one shown. */
  banner: { ms: 1200, maxQueued: 2 },
  /** A tag sits this many px above the head's top bar line (above the health bar and the name). */
  tagAbovePx: 32,
} as const;

interface Tag {
  text: Phaser.GameObjects.Text;
  born: number;
  scale: number;
  last: Vec2;
}

/**
 * Shows the server's callouts in two sizes: small tags that follow the victim's head (one per player: a new one
 * replaces the old) and big banners for the big moments, queued in the HUD. Which is which: `CALLOUT_SIZE` (shared).
 */
export class CalloutLayer {
  private tags = new Map<string, Tag>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly hud: HudScene,
    private readonly log: Logger,
  ) {}

  show(kind: CalloutKind, victim: string, by: string | null, at: Vec2, size: number, nameOf: (id: string) => string): void {
    const st = CALLOUT_STYLE[kind];
    if (CALLOUT_SIZE[kind] === 'banner') {
      const sub = by && by !== victim ? `${nameOf(by)} on ${nameOf(victim)}` : nameOf(victim);
      const r = this.hud.banner({ text: st.text, fill: st.fill, stroke: st.stroke, size: st.size, sub, ms: CALLOUT_LOOK.banner.ms }, CALLOUT_LOOK.banner.maxQueued);
      this.log.info('callout_shown', { kind, size: 'banner', victim, queued: r.queued });
      if (r.dropped) this.log.info('callout_dropped', { dropped: r.dropped, why: 'banner_queue_full', max: CALLOUT_LOOK.banner.maxQueued });
      return;
    }
    this.tags.get(victim)?.text.destroy();
    const text = this.scene.add
      .text(px(at.x), px(at.y), st.text, { fontFamily: 'Impact, Arial Black, sans-serif', fontSize: `${Math.round(st.size * CALLOUT_LOOK.tag.scale)}px`, color: st.fill, stroke: st.stroke, strokeThickness: 4 })
      .setOrigin(0.5, 1)
      .setDepth(20);
    this.tags.set(victim, { text, born: performance.now(), scale: 0.9 + 0.25 * Math.max(0, Math.min(1, size)), last: { ...at } });
    this.log.info('callout_shown', { kind, size: 'tag', victim });
  }

  /** Moves each tag over its victim's head (`headTop`: top of the head in m, or null if gone) and ages it. */
  update(headTop: (id: string) => Vec2 | null): void {
    const now = performance.now();
    const L = CALLOUT_LOOK.tag;
    for (const [id, t] of this.tags) {
      const age = now - t.born;
      if (age >= L.ms) {
        t.text.destroy();
        this.tags.delete(id);
        continue;
      }
      const head = headTop(id);
      if (head) t.last = head;
      const pop = Math.min(1, age / L.popMs);
      t.text.setScale(t.scale * (0.6 + 0.4 * pop)).setAlpha(Math.min(1, (L.ms - age) / L.fadeMs));
      // kept inside the view, so a tag on someone at the screen edge isn't cut off
      const view = this.scene.cameras.main.worldView;
      const half = t.text.displayWidth / 2 + 4;
      const x = view.width > half * 2 ? Math.max(view.x + half, Math.min(view.right - half, px(t.last.x))) : px(t.last.x);
      t.text.setPosition(x, Math.max(view.y + t.text.displayHeight + 4, px(t.last.y) - CALLOUT_LOOK.tagAbovePx - 6 * (age / L.ms)));
    }
  }

  /** New match / world reset: drop the tags. */
  clear(): void {
    for (const t of this.tags.values()) t.text.destroy();
    this.tags.clear();
  }
}
