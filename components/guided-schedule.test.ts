import { describe, expect, test } from 'bun:test'
import { RRule } from 'rrule'
import { buildCalendarSchedule, canEditCalendarSchedule, initialCalendarSchedule } from './guided-schedule'

const draft = () => initialCalendarSchedule(undefined, '2026-11-03')

describe('guided calendar schedules', () => {
  test('stores the requested interval and explicit local date boundaries', () => {
    const rule = RRule.fromString(buildCalendarSchedule({ ...draft(), interval: 10, endsOn: '2027-02-01' }, 'Europe/London'))
    expect(rule.origOptions.interval).toBe(10)
    expect(rule.origOptions.dtstart?.toISOString()).toBe('2026-11-03T00:00:00.000Z')
    expect(rule.origOptions.until?.toISOString()).toBe('2027-02-01T23:59:59.000Z')
    expect(rule.origOptions.tzid).toBe('Europe/London')
  })

  test('supports chosen weekdays, nth weekdays, and a final day of the month', () => {
    const weekly = buildCalendarSchedule({ ...draft(), unit: 'weeks', interval: 3, weekdays: [0, 3] }, 'America/Chicago')
    expect(initialCalendarSchedule(weekly, '2027-01-01')).toMatchObject({ unit: 'weeks', interval: 3, weekdays: [0, 3], startsOn: '2026-11-03' })
    const monthly = buildCalendarSchedule({ ...draft(), unit: 'months', monthPattern: 'weekday', ordinal: -1, weekday: 4 }, 'America/Chicago')
    expect(initialCalendarSchedule(monthly, '2027-01-01')).toMatchObject({ unit: 'months', monthPattern: 'weekday', ordinal: -1, weekday: 4 })
    const yearly = buildCalendarSchedule({ ...draft(), unit: 'years', month: 2, monthDay: -1 }, 'Pacific/Auckland')
    expect(initialCalendarSchedule(yearly, '2027-01-01')).toMatchObject({ unit: 'years', month: 2, monthDay: -1 })
  })

  test('does not claim complex legacy patterns can be edited by a simpler control', () => {
    for (const text of ['FREQ=DAILY;BYHOUR=9', 'FREQ=YEARLY;BYMONTH=1,6;BYMONTHDAY=3', 'FREQ=MONTHLY;BYDAY=MO', 'FREQ=MONTHLY;BYMONTHDAY=-2', 'FREQ=WEEKLY;BYDAY=MO;COUNT=10']) {
      expect(canEditCalendarSchedule(text)).toBe(false)
    }
    expect(canEditCalendarSchedule('DTSTART:20260115T000000Z\nRRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR')).toBe(true)
  })

  test('uses an existing anchor for an implicit month date when opening the editor', () => {
    expect(initialCalendarSchedule('DTSTART:20260115T000000Z\nRRULE:FREQ=YEARLY', '2026-11-03')).toMatchObject({ monthDay: 15, month: 1 })
  })

  test('rejects invalid intervals, empty weekday selections, and reversed date ranges', () => {
    expect(() => buildCalendarSchedule({ ...draft(), interval: 0 }, 'Europe/London')).toThrow()
    expect(() => buildCalendarSchedule({ ...draft(), interval: 366 }, 'Europe/London')).toThrow()
    expect(() => buildCalendarSchedule({ ...draft(), unit: 'weeks', weekdays: [] }, 'Europe/London')).toThrow()
    expect(() => buildCalendarSchedule({ ...draft(), endsOn: '2026-10-01' }, 'Europe/London')).toThrow()
  })
})
