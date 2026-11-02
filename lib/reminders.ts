import { DateTime } from 'luxon'
import type { Habit } from './types'
import { getCompletionsForDate, isHabitDue } from './utils'
import { getTaskMissedDates } from './task-schedule'

export function reminderDueDate(habit: Habit, now: DateTime, timezone: string, leadMinutes: number): string | null {
  if (!habit.reminderTime || habit.archived || !Number.isFinite(leadMinutes) || leadMinutes < 0 || leadMinutes > 60) return null
  const localNow = now.setZone(timezone)
  const [hour, minute] = habit.reminderTime.split(':').map(Number)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null

  for (const day of [localNow.startOf('day'), localNow.plus({ days: 1 }).startOf('day')]) {
    const due = isHabitDue({ habit, date: day, timezone }) ||
      day.hasSame(localNow, 'day') && getTaskMissedDates(habit, localNow, timezone).length > 0
    if (!due || getCompletionsForDate({ habit, date: day, timezone }) >= (habit.targetCompletions ?? 1)) continue
    const remindAt = day.set({ hour, minute }).minus({ minutes: leadMinutes })
    if (localNow >= remindAt && localNow <= day.endOf('day')) return day.toISODate()
  }
  return null
}
