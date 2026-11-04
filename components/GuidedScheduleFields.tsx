'use client'

import { useTranslations } from 'next-intl'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import type { CalendarScheduleDraft } from './guided-schedule'

interface GuidedScheduleFieldsProps {
  value: CalendarScheduleDraft
  onChange: (value: CalendarScheduleDraft) => void
  language: string
  afterCompletion?: boolean
}

const selectClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm'

export default function GuidedScheduleFields({ value, onChange, language, afterCompletion }: GuidedScheduleFieldsProps) {
  const t = useTranslations('AddEditHabitModal')
  const update = (change: Partial<CalendarScheduleDraft>) => onChange({ ...value, ...change })
  const weekdayLabel = (index: number, style: 'long' | 'short' = 'long') => new Intl.DateTimeFormat(language, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 2 + index)))
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor="schedule-interval" className="block">{t(afterCompletion ? 'scheduleAfterInterval' : 'scheduleInterval')}</Label>
        <Input id="schedule-interval" type="number" min={1} max={365} className="w-20" required value={value.interval}
          onChange={event => update({ interval: Number(event.target.value) })} />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor="schedule-unit" className="block">{t('scheduleUnit')}</Label>
        <select id="schedule-unit" className={`${selectClass} w-full`} value={value.unit}
          onChange={event => update({ unit: event.target.value as CalendarScheduleDraft['unit'] })}>
          {(['days', 'weeks', 'months', 'years'] as const).map(unit => <option key={unit} value={unit}>{t(`scheduleUnit_${unit}`)}</option>)}
        </select>
      </div>
    </div>
    {!afterCompletion && value.unit === 'weeks' && <div role="group" aria-label={t('scheduleChosenDays')} className="flex flex-wrap gap-1">
      {Array.from({ length: 7 }, (_, index) => <Button key={index} type="button" size="sm"
        variant={value.weekdays.includes(index) ? 'default' : 'outline'} aria-label={weekdayLabel(index)}
        aria-pressed={value.weekdays.includes(index)} onClick={() => update({ weekdays: value.weekdays.includes(index)
          ? value.weekdays.length > 1 ? value.weekdays.filter(day => day !== index) : value.weekdays
          : [...value.weekdays, index] })}>{weekdayLabel(index, 'short')}</Button>)}
    </div>}
    {!afterCompletion && value.unit === 'months' && <div className="space-y-1">
      <Label htmlFor="schedule-month-pattern" className="block">{t('scheduleMonthPattern')}</Label>
      <select id="schedule-month-pattern" className={`${selectClass} w-full`} value={value.monthPattern}
        onChange={event => update({ monthPattern: event.target.value as CalendarScheduleDraft['monthPattern'] })}>
        <option value="date">{t('scheduleMonthDate')}</option><option value="weekday">{t('scheduleMonthWeekday')}</option>
      </select>
    </div>}
    {!afterCompletion && value.unit === 'months' && value.monthPattern === 'weekday' && <div className="flex flex-wrap gap-2">
      <div className="space-y-1"><Label htmlFor="schedule-ordinal" className="block">{t('scheduleOrdinal')}</Label>
        <select id="schedule-ordinal" className={selectClass} value={value.ordinal} onChange={event => update({ ordinal: Number(event.target.value) })}>
          {[1, 2, 3, 4, -1].map(ordinal => <option key={ordinal} value={ordinal}>{t(`scheduleOrdinal_${ordinal === -1 ? 'last' : ordinal}`)}</option>)}
        </select></div>
      <div className="min-w-0 flex-1 space-y-1"><Label htmlFor="schedule-weekday" className="block">{t('scheduleWeekday')}</Label>
        <select id="schedule-weekday" className={`${selectClass} w-full`} value={value.weekday} onChange={event => update({ weekday: Number(event.target.value) })}>
          {Array.from({ length: 7 }, (_, index) => <option key={index} value={index}>{weekdayLabel(index)}</option>)}
        </select></div>
    </div>}
    {!afterCompletion && value.unit === 'years' && <div className="space-y-1"><Label htmlFor="schedule-month" className="block">{t('scheduleMonth')}</Label>
      <select id="schedule-month" className={`${selectClass} w-full`} value={value.month} onChange={event => update({ month: Number(event.target.value) })}>
        {Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{new Intl.DateTimeFormat(language, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, index, 1)))}</option>)}
      </select></div>}
    {!afterCompletion && (value.unit === 'years' || value.unit === 'months' && value.monthPattern === 'date') && <div className="space-y-1">
      <Label htmlFor="schedule-month-day" className="block">{t('scheduleMonthDay')}</Label>
      <select id="schedule-month-day" className={`${selectClass} w-full`} value={value.monthDay} onChange={event => update({ monthDay: Number(event.target.value) })}>
        {Array.from({ length: 31 }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
        <option value={-1}>{t('scheduleLastDay')}</option>
      </select><p className="text-xs text-muted-foreground">{t('scheduleMissingDateHelp')}</p>
    </div>}
    <div className="grid min-w-0 grid-cols-1 gap-3 xs:grid-cols-2">
      <div className="min-w-0 space-y-1"><Label htmlFor="schedule-start" className="block">{t('scheduleStartsOn')}</Label>
        <Input id="schedule-start" type="date" className="min-w-0" required value={value.startsOn} onChange={event => update({ startsOn: event.target.value })} /></div>
      <div className="min-w-0 space-y-1"><Label htmlFor="schedule-end" className="block">{t('scheduleEndsOn')}</Label>
        <Input id="schedule-end" type="date" className="min-w-0" min={value.startsOn} value={value.endsOn} onChange={event => update({ endsOn: event.target.value })} /></div>
    </div>
    {afterCompletion && <p className="text-xs text-muted-foreground">{t('scheduleAfterHelp')}</p>}
  </div>
}
