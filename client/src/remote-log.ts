import { Logger, type LogEntry } from '@ragdoll/shared';

const FLUSH_MS = 500;

/**
 * Logger whose lines end up in logs/client-latest.jsonl (via the dev server's /__log).
 * Also captures uncaught errors and console.error, so crashes show up in the log file too.
 * Built pages (hosted) have no /__log: lines are dropped there instead of piling up in memory.
 */
export function createRemoteLogger(): Logger {
  const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!import.meta.env.DEV) return new Logger('client', () => {});
  let queue: LogEntry[] = [];

  const flush = (useBeacon = false) => {
    if (!queue.length) return;
    const body = JSON.stringify({ session, entries: queue });
    queue = [];
    if (useBeacon) navigator.sendBeacon('/__log', body);
    else fetch('/__log', { method: 'POST', body, keepalive: true }).catch(() => {});
  };
  setInterval(flush, FLUSH_MS);
  addEventListener('pagehide', () => flush(true));

  const log = new Logger('client', (e) => {
    queue.push(e);
    if (e.lvl === 'error') flush();
  });

  addEventListener('error', (e) => log.error('js_error', { msg: e.message, at: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error?.stack }));
  addEventListener('unhandledrejection', (e) => log.error('js_unhandled_rejection', { msg: String(e.reason), stack: e.reason?.stack }));
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    log.error('console_error', { msg: args.map(String).join(' ') });
    consoleError(...args);
  };

  log.info('session_start', { session, ua: navigator.userAgent, screen: [innerWidth, innerHeight], dpr: devicePixelRatio });
  return log;
}
