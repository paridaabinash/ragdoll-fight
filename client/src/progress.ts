import { countProgress, HATS, isHat, readProgress, unlockedHats, type GameEvent, type HatKind, type Logger, type MatchInfo, type Progress } from '@ragdoll/shared';

const PROGRESS_KEY = 'ragdoll.progress';
const HAT_KEY = 'ragdoll.hat';
/** Crown time is saved at most this often (it changes every frame while you wear it). */
const SAVE_EVERY_MS = 5000;

/**
 * Your hat progress (kills, pins, wins...), kept on this device (localStorage). Counted from the game events the
 * screen shows, so it only ever unlocks cosmetics: nothing here changes the game.
 */
export class HatProgress {
  private lastSaveAt = 0;
  private dirty = false;
  private crownMs = 0;
  private countedWin = -1;

  private constructor(
    readonly p: Progress,
    private readonly log: Logger,
  ) {}

  static load(log: Logger): HatProgress {
    let raw: unknown = null;
    try {
      raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? 'null');
    } catch {
      /* blocked or broken storage: start fresh */
    }
    return new HatProgress(readProgress(raw), log);
  }

  /** Counts a shown event; returns the names of hats it unlocked. */
  event(ev: GameEvent, me: string): string[] {
    return this.change(() => countProgress(this.p, ev, me));
  }

  /** Time wearing the crown (ms). */
  crown(ms: number): string[] {
    this.crownMs += ms;
    const whole = Math.floor(this.crownMs / 1000);
    if (!whole) return [];
    this.crownMs -= whole * 1000;
    return this.change(() => ((this.p.crownSeconds += whole), true), false);
  }

  /** A finished match: a win counts once. */
  result(m: MatchInfo, me: string): string[] {
    if (m.phase !== 'results' || m.result?.winner !== me || this.countedWin === m.number) return [];
    this.countedWin = m.number;
    return this.change(() => (this.p.wins++, true));
  }

  private change(fn: () => boolean, saveNow = true): string[] {
    const before = new Set(unlockedHats(this.p));
    if (!fn()) return [];
    this.dirty = true;
    if (saveNow || performance.now() - this.lastSaveAt > SAVE_EVERY_MS) this.save();
    const fresh = HATS.filter((h) => h.unlocked(this.p) && !before.has(h.kind)).map((h) => h.name);
    if (fresh.length) this.log.info('hat_unlocked', { hats: fresh, progress: { ...this.p } });
    return fresh;
  }

  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastSaveAt = performance.now();
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(this.p));
    } catch {
      /* not important */
    }
  }
}

/** The hat picked on the join screen last time (if still unlocked). */
export function savedHat(p: Progress): HatKind {
  let v: string | null = null;
  try {
    v = localStorage.getItem(HAT_KEY);
  } catch {
    /* blocked */
  }
  return isHat(v) && unlockedHats(p).includes(v) ? v : 'none';
}

export function saveHat(hat: HatKind): void {
  try {
    localStorage.setItem(HAT_KEY, hat);
  } catch {
    /* not important */
  }
}
