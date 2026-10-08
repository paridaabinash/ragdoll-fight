import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry, LogSink } from '../shared/src/log';

/** How often a background sink writes its queue (ms). Short enough that `tail -f` stays useful. */
const FLUSH_MS = 200;

export const LOG_DIR = path.resolve(import.meta.dirname, '../logs');

/**
 * Starts a fresh `<name>-latest.jsonl`, keeping the previous run as `<name>-prev.jsonl`.
 * Returns the path of the new file.
 */
export function startLogFile(name: string): string {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const latest = path.join(LOG_DIR, `${name}-latest.jsonl`);
  if (fs.existsSync(latest)) fs.renameSync(latest, path.join(LOG_DIR, `${name}-prev.jsonl`));
  fs.writeFileSync(latest, '');
  return latest;
}

export function appendEntries(file: string, entries: LogEntry[]): void {
  if (entries.length) fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

export type FileSink = LogSink & {
  file: string;
  /** Writes everything still queued (background sinks); resolves when it's on disk. */
  flush(): Promise<void>;
};

/**
 * A sink that writes each entry to `logs/<name>-latest.jsonl`.
 * - default: written at once (simple and crash-safe; fine for batch tools like the sim).
 * - `background: true`: queued and written off the main thread every `FLUSH_MS`. The game server uses this: on this
 *   disk one synchronous write sometimes stalls 30-50 ms, and inside a 60 Hz tick that freezes the whole room
 *   (measured with tools/tick-probe.ts; see "Server tick cost" in ragdoll architecture.md). Whatever is still queued
 *   when the process exits is written synchronously then, so nothing is lost on a normal exit or a crash.
 */
export function fileSink(name: string, opts: { background?: boolean } = {}): FileSink {
  const file = startLogFile(name);
  if (!opts.background) {
    const sink = ((e: LogEntry) => appendEntries(file, [e])) as FileSink;
    return Object.assign(sink, { file, flush: async () => {} });
  }
  let queue: string[] = [];
  let writing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const take = () => {
    const text = queue.join('');
    queue = [];
    return text;
  };
  const writeQueued = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (writing || !queue.length) return writing ?? Promise.resolve();
    writing = fs.promises.appendFile(file, take()).finally(() => {
      writing = null;
      if (queue.length) schedule();
    });
    return writing;
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(writeQueued, FLUSH_MS).unref(); // unref: a pending flush never keeps the process alive
  };
  // On exit nothing async runs any more: write the rest now. (A write already in progress is in the OS's hands.)
  process.on('exit', () => {
    if (queue.length) fs.appendFileSync(file, take());
  });
  const sink = ((e: LogEntry) => {
    queue.push(JSON.stringify(e) + '\n');
    schedule();
  }) as FileSink;
  return Object.assign(sink, {
    file,
    async flush() {
      while (writing || queue.length) await (writing ?? writeQueued());
    },
  });
}
