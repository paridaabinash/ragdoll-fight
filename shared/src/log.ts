export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One line in a .jsonl log file. `ev` is the event name; everything else is event data. */
export interface LogEntry {
  /** ms since the logger was created */
  t: number;
  tick?: number;
  src: string;
  lvl: LogLevel;
  ev: string;
  [key: string]: unknown;
}

export type LogSink = (entry: LogEntry) => void;

export class Logger {
  /** Set by the game world so every line carries the physics tick. */
  tickSource: (() => number) | null = null;
  private readonly start = performance.now();

  constructor(
    readonly src: string,
    private readonly sink: LogSink,
  ) {}

  debug(ev: string, data?: Record<string, unknown>): void {
    this.write('debug', ev, data);
  }
  info(ev: string, data?: Record<string, unknown>): void {
    this.write('info', ev, data);
  }
  warn(ev: string, data?: Record<string, unknown>): void {
    this.write('warn', ev, data);
  }
  error(ev: string, data?: Record<string, unknown>): void {
    this.write('error', ev, data);
  }

  private write(lvl: LogLevel, ev: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = { t: Math.round(performance.now() - this.start), src: this.src, lvl, ev };
    if (this.tickSource) entry.tick = this.tickSource();
    this.sink(data ? { ...entry, ...data } : entry);
  }
}

/** Keeps entries in memory. Used by tests to assert on what was logged. */
export function memorySink(): LogSink & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const sink = ((e: LogEntry) => void entries.push(e)) as LogSink & { entries: LogEntry[] };
  sink.entries = entries;
  return sink;
}
