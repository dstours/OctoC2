/**
 * OctoC2 Beacon — Logger
 *
 * A minimal, level-gated console logger. Output format:
 *
 *   2026-03-27T12:00:00.000Z [INFO ] [svc] Beacon starting...
 *
 * Minimum log level is controlled via SVC_LOG_LEVEL (default: "info").
 * Valid values: debug, info, warn, error.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

function resolveMinLevel(): LogLevel {
  const raw = (process.env["SVC_LOG_LEVEL"] ?? "info").toLowerCase();
  return (raw in LEVEL_NUM) ? (raw as LogLevel) : "info";
}

export class Logger {
  private readonly prefix: string;
  private readonly minNum: number;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.minNum  = LEVEL_NUM[resolveMinLevel()];
  }

  private emit(level: LogLevel, msg: string): void {
    if (LEVEL_NUM[level] < this.minNum) return;
    const ts   = new Date().toISOString();
    const lvl  = level.toUpperCase().padEnd(5);
    const line = `${ts} [${lvl}] [${this.prefix}] ${msg}`;
    if (level === "error") console.error(line);
    else if (level === "warn")  console.warn(line);
    else                        console.log(line);
  }

  debug(msg: string): void { this.emit("debug", msg); }
  info(msg: string):  void { this.emit("info",  msg); }
  warn(msg: string):  void { this.emit("warn",  msg); }
  error(msg: string): void { this.emit("error", msg); }
}

/** Convenience factory. Each module creates its own logger with a short prefix. */
export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}
