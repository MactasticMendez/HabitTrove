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

export function getCurrentStreak(completions: ReadonlyMap<string, Habit[]>, today: DateTime): number {
  let date = today
  if (!completions.get(date.toISODate()!)?.length) date = date.minus({ days: 1 })

  let streak = 0
  while (completions.get(date.toISODate()!)?.length) {
    streak += 1
    date = date.minus({ days: 1 })
  }
  return streak
}
