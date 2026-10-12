import { Logger } from '@ragdoll/shared';

/**
 * A logger for the home page's own little worlds (the bot fight behind the menu, the character card): only their
 * warnings and errors reach the real log. Their info lines (every bot's walk, landing, shot) filled the client log
 * with thousands of lines from every device sitting on the menu, burying the lines that explain real games.
 */
export function quietLogger(src: string, real: Logger): Logger {
  return new Logger(src, (e) => {
    if (e.lvl !== 'warn' && e.lvl !== 'error') return;
    const { t: _t, src: _s, lvl, ev, ...data } = e;
    real[lvl](ev, { from: src, ...data });
  });
}
