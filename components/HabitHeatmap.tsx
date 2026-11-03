'use client'

import { DateTime } from 'luxon'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { completedHabitsMapAtom, settingsAtom } from '@/lib/atoms'
import { getActivityDays } from '@/lib/activity'
import { useTodayInTimezone } from '@/hooks/useTodayInTimezone'

const intensity = [
  'bg-muted',
  'bg-emerald-200 dark:bg-emerald-900',
  'bg-emerald-400 dark:bg-emerald-700',
  'bg-emerald-600 dark:bg-emerald-500',
  'bg-emerald-800 dark:bg-emerald-300',
]

export default function HabitHeatmap() {
  const t = useTranslations('HabitHeatmap')
  const [settings] = useAtom(settingsAtom)
  const [completedHabitsMap] = useAtom(completedHabitsMapAtom)
  const today = useTodayInTimezone(settings.system.timezone)
  const currentDay = DateTime.fromISO(today, { zone: settings.system.timezone })
  const days = getActivityDays(completedHabitsMap, currentDay, 84)
  const total = days.reduce((sum, day) => sum + day.total, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('summary', { count: total })}</p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto pb-2">
          <div className="grid grid-flow-col grid-rows-7 gap-1 w-max" role="group" aria-label={t('title')}>
            {days.map(day => {
              const date = DateTime.fromISO(day.date, { zone: settings.system.timezone })
                .setLocale(settings.system.language).toLocaleString(DateTime.DATE_FULL)
              const label = t('dayActivity', { date, count: day.total })
              return (
                <span
                  key={day.date}
                  tabIndex={0}
                  role="img"
                  aria-label={label}
                  className={`group relative h-6 w-6 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${intensity[Math.min(day.total, 4)]}`}
                >
                  <span aria-hidden="true" className="pointer-events-none absolute z-10 bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-popover px-2 py-1 text-xs text-popover-foreground shadow group-hover:block group-focus:block">
                    {label}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
