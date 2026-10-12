import Phaser from 'phaser';
import type { Logger } from '@ragdoll/shared';

/** Set when the game itself frees the mouse (e.g. for the vote cards), so that doesn't open the menu. */
let quietUnlockUntil = 0;

/** Frees the mouse from the game without opening the in-game menu (the vote cards need the cursor). */
export function freePointer(): void {
  if (!document.pointerLockElement) return;
  quietUnlockUntil = performance.now() + 500;
  document.exitPointerLock();
}

/**
 * M6: the in-game menu. A small "Menu" button in the corner, and Esc, open a panel with Resume and Leave game.
 * While playing the mouse is locked to the game, and the browser itself uses Esc to free it: so the panel opens when
 * the lock is lost (Esc, or switching windows), and Esc toggles it when the mouse is free. Online the match keeps going
 * behind the panel (nobody can pause a shared game); your keys are let go while it's open.
 */
export class GameMenu {
  private readonly button: HTMLButtonElement;
  private readonly sheet: HTMLDivElement;
  private open = false;
  /** When the mouse lock was last lost (the browser's own Esc), so the same key press doesn't close the panel again. */
  private unlockedAt = -Infinity;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly log: Logger,
    private readonly opts: { online: boolean; leave: () => void },
  ) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'game-menu-btn';
    this.button.innerHTML = '☰ <span>Menu</span> <kbd>Esc</kbd>';
    this.button.onclick = () => this.show('button');

    this.sheet = document.createElement('div');
    this.sheet.className = 'game-menu';
    this.sheet.hidden = true;
    const note = opts.online ? 'The match keeps going while this is open.' : 'Practice: the bot keeps going while this is open.';
    this.sheet.innerHTML = `
      <div class="game-menu-panel" role="dialog" aria-label="Game menu">
        <h2>Menu</h2>
        <p class="hint">${note}</p>
        <button type="button" class="btn-play gm-resume">RESUME</button>
        <button type="button" class="btn-sub gm-leave">Leave game</button>
      </div>`;
    this.sheet.querySelector<HTMLButtonElement>('.gm-resume')!.onclick = () => this.hide('button', true);
    this.sheet.querySelector<HTMLButtonElement>('.gm-leave')!.onclick = () => this.leave();
    // a click on the dark shade around the panel: back to the game
    // (a block, not `a && b`: an `onclick` returning false cancels the click's default action, see menu.ts)
    this.sheet.onclick = (e) => {
      if (e.target === this.sheet) this.hide('shade', true);
    };
    document.body.append(this.button, this.sheet);

    const canvas = scene.game.canvas;
    const onLock = () => {
      if (document.pointerLockElement === canvas) return;
      this.unlockedAt = performance.now();
      if (this.unlockedAt < quietUnlockUntil) return; // the game freed it on purpose
      this.show('lock_lost');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return;
      if (performance.now() - this.unlockedAt < 300) return; // the same press that freed the mouse (already opened)
      if (this.open) this.hide('esc', false);
      else this.show('esc');
    };
    document.addEventListener('pointerlockchange', onLock);
    addEventListener('keydown', onKey);
    this.cleanups.push(
      () => document.removeEventListener('pointerlockchange', onLock),
      () => removeEventListener('keydown', onKey),
    );
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
    scene.events.once(Phaser.Scenes.Events.DESTROY, () => this.destroy());
  }

  get isOpen(): boolean {
    return this.open;
  }

  private show(how: string): void {
    if (this.open) return;
    this.open = true;
    this.sheet.hidden = false;
    this.button.hidden = true;
    // let go of every key: nothing walks or fires on its own while the panel is up
    const kb = this.scene.input.keyboard;
    if (kb) {
      kb.resetKeys();
      kb.enabled = false;
    }
    if (document.pointerLockElement) freePointer();
    this.log.info('game_menu', { open: true, how, online: this.opts.online });
  }

  /** `relock`: lock the mouse to the game again (only from a click: browsers refuse it from a key press). */
  private hide(how: string, relock: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.sheet.hidden = true;
    this.button.hidden = false;
    const kb = this.scene.input.keyboard;
    if (kb) kb.enabled = true;
    if (relock) {
      const req = this.scene.game.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      req?.catch?.(() => undefined); // refused (too soon after Esc): the next click on the game locks it
    }
    this.log.info('game_menu', { open: false, how });
  }

  private leave(): void {
    this.log.info('game_leave', { online: this.opts.online });
    this.opts.leave();
  }

  destroy(): void {
    this.cleanups.splice(0).forEach((f) => f());
    this.button.remove();
    this.sheet.remove();
  }
}
