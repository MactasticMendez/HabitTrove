import 'server-only'
import { getApplicationLogLevel, type LogLevel } from './admin-config'

const levelRank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function log(level: LogLevel, message: string, ...details: unknown[]): void {
  if (levelRank[level] < levelRank[getApplicationLogLevel()]) return
  const write = level === 'debug' ? console.debug : level === 'info' ? console.info :
    level === 'warn' ? console.warn : console.error
  write(`[HabitTrove] ${message}`, ...details)
}
