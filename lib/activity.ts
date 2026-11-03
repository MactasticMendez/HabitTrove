import { DateTime } from 'luxon'
import { Habit } from './types'

export type ActivityDay = {
  date: string
  habits: number
  tasks: number
  total: number
}

export function getActivityDays(
  completions: ReadonlyMap<string, Habit[]>,
  today: DateTime,
  days: number,
): ActivityDay[] {
  return Array.from({ length: days }, (_, index) => {
    const date = today.minus({ days: days - index - 1 }).toISODate()!
    const completed = completions.get(date) ?? []
    const tasks = completed.filter(item => item.isTask).length
    const habits = completed.length - tasks
    return { date, habits, tasks, total: completed.length }
  })
}

export function getCurrentStreak(completions: ReadonlyMap<string, Habit[]>, today: DateTime, pausedDates: ReadonlySet<string> = new Set()): number {
  let date = today
  if (!completions.get(date.toISODate()!)?.length && !pausedDates.has(date.toISODate()!)) date = date.minus({ days: 1 })

  let streak = 0
  for (let days = 0; days < 365; days++) {
    const key = date.toISODate()!
    if (pausedDates.has(key)) {
      date = date.minus({ days: 1 })
      continue
    }
    if (!completions.get(key)?.length) break
    streak++
    date = date.minus({ days: 1 })
  }
  return streak
}
