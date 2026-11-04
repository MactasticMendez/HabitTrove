import { datetime, RRule } from 'rrule'
import { DateTime } from 'luxon'

export type CalendarScheduleDraft = {
  unit: 'days' | 'weeks' | 'months' | 'years'
  interval: number
  startsOn: string
  endsOn: string
  weekdays: number[]
  monthPattern: 'date' | 'weekday'
  monthDay: number
  ordinal: number
  weekday: number
  month: number
}

const weekdayIndex = (day: number | string | { weekday: number }) => typeof day === 'number' ? day : typeof day === 'string' ? ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].indexOf(day) : day.weekday

export function initialCalendarSchedule(frequency: string | undefined, today: string): CalendarScheduleDraft {
  const current = DateTime.fromISO(today)
  const fallback: CalendarScheduleDraft = {
    unit: 'days', interval: 1, startsOn: today, endsOn: '', weekdays: [current.weekday - 1],
    monthPattern: 'date', monthDay: current.day, ordinal: 1, weekday: current.weekday - 1, month: current.month,
  }
  if (!frequency) return fallback
  try {
    const rule = RRule.fromString(frequency)
    const options = rule.origOptions
    const starts = options.dtstart
    const end = options.until
    const selected = Array.isArray(options.byweekday) ? options.byweekday : options.byweekday == null ? [] : [options.byweekday]
    const first = selected[0]
    const position = typeof first === 'object' ? first.n : undefined
    const monthday = Array.isArray(options.bymonthday) ? options.bymonthday[0] : options.bymonthday
    const month = Array.isArray(options.bymonth) ? options.bymonth[0] : options.bymonth
    return {
      ...fallback,
      unit: options.freq === RRule.WEEKLY ? 'weeks' : options.freq === RRule.MONTHLY ? 'months' : options.freq === RRule.YEARLY ? 'years' : 'days',
      interval: options.interval ?? 1,
      startsOn: starts ? DateTime.fromJSDate(starts, { zone: 'utc' }).toISODate()! : today,
      endsOn: end ? DateTime.fromJSDate(end, { zone: 'utc' }).toISODate()! : '',
      weekdays: selected.length ? selected.map(weekdayIndex) : fallback.weekdays,
      monthPattern: position || options.bysetpos ? 'weekday' : 'date',
      monthDay: monthday ?? starts?.getUTCDate() ?? fallback.monthDay,
      ordinal: position ?? (Array.isArray(options.bysetpos) ? options.bysetpos[0] : options.bysetpos) ?? 1,
      weekday: first == null ? fallback.weekday : weekdayIndex(first),
      month: month ?? (starts ? starts.getUTCMonth() + 1 : fallback.month),
    }
  } catch { return fallback }
}

export function canEditCalendarSchedule(frequency: string): boolean {
  try {
    const options = RRule.fromString(frequency).origOptions
    if (![RRule.DAILY, RRule.WEEKLY, RRule.MONTHLY, RRule.YEARLY].includes(options.freq!)) return false
    if (options.count || options.byhour || options.byminute || options.bysecond || options.byweekno || options.byyearday) return false
    const days = Array.isArray(options.byweekday) ? options.byweekday : options.byweekday == null ? [] : [options.byweekday]
    if (options.freq === RRule.DAILY && (days.length || options.bymonth || options.bymonthday || options.bysetpos)) return false
    if (options.freq === RRule.WEEKLY && (options.bymonth || options.bymonthday || options.bysetpos || days.some(day => typeof day === 'object' && day.n))) return false
    if (options.freq === RRule.MONTHLY && (options.bymonth || days.length > 1)) return false
    if (options.freq === RRule.MONTHLY && days.length && !options.bysetpos && !days.some(day => typeof day === 'object' && day.n)) return false
    const positions = Array.isArray(options.bysetpos) ? options.bysetpos : options.bysetpos == null ? [] : [options.bysetpos]
    if (positions.some(position => ![1, 2, 3, 4, -1].includes(position)) || days.some(day => typeof day === 'object' && day.n && ![1, 2, 3, 4, -1].includes(day.n))) return false
    const monthDays = Array.isArray(options.bymonthday) ? options.bymonthday : options.bymonthday == null ? [] : [options.bymonthday]
    if (monthDays.some(day => day !== -1 && (day < 1 || day > 31))) return false
    if (options.freq === RRule.YEARLY && (days.length || options.bysetpos)) return false
    for (const value of [options.bymonth, options.bymonthday, options.bysetpos]) if (Array.isArray(value) && value.length > 1) return false
    return true
  } catch { return false }
}

export function buildCalendarSchedule(draft: CalendarScheduleDraft, timezone: string): string {
  const start = DateTime.fromISO(draft.startsOn, { zone: timezone })
  const end = draft.endsOn ? DateTime.fromISO(draft.endsOn, { zone: timezone }) : null
  if (!start.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(draft.startsOn) ||
      end && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.endsOn) || !end.isValid || end < start) ||
      !Number.isSafeInteger(draft.interval) || draft.interval < 1 || draft.interval > 365) throw new Error('Invalid schedule')
  if (!['days', 'weeks', 'months', 'years'].includes(draft.unit) ||
      !Array.isArray(draft.weekdays) || draft.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
      !Number.isInteger(draft.weekday) || draft.weekday < 0 || draft.weekday > 6 ||
      ![1, 2, 3, 4, -1].includes(draft.ordinal) ||
      !Number.isInteger(draft.monthDay) || draft.monthDay !== -1 && (draft.monthDay < 1 || draft.monthDay > 31) ||
      !Number.isInteger(draft.month) || draft.month < 1 || draft.month > 12) throw new Error('Invalid schedule')
  const days = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU]
  if (draft.unit === 'weeks' && !draft.weekdays.length) throw new Error('Choose at least one weekday')
  return new RRule({
    freq: { days: RRule.DAILY, weeks: RRule.WEEKLY, months: RRule.MONTHLY, years: RRule.YEARLY }[draft.unit],
    interval: draft.interval,
    dtstart: datetime(start.year, start.month, start.day), tzid: timezone,
    ...(end && { until: datetime(end.year, end.month, end.day, 23, 59, 59) }),
    ...(draft.unit === 'weeks' && { byweekday: draft.weekdays.map(index => days[index]) }),
    ...(draft.unit === 'months' && (draft.monthPattern === 'weekday'
      ? { byweekday: days[draft.weekday].nth(draft.ordinal) } : { bymonthday: draft.monthDay })),
    ...(draft.unit === 'years' && { bymonth: draft.month, bymonthday: draft.monthDay }),
  }).toString()
}
