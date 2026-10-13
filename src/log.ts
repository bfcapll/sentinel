import { pino, type Logger } from 'pino';

export type { Logger };

export interface LogOptions {
  level?: string;
  /** Log file path; stdout when omitted. */
  file?: string;
}

export function createLogger(opts: LogOptions = {}): Logger {
  const level = opts.level ?? 'info';
  if (opts.file) return pino({ level }, pino.destination({ dest: opts.file, mkdir: true, sync: false }));
  return pino({ level });
}

/** A logger that discards everything (tests, replay). */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
