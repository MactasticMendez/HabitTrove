'use client'

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DateTime } from 'luxon'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { Flame } from 'lucide-react'
import { settingsAtom, hasTasksAtom, completedHabitsMapAtom } from '@/lib/atoms'
import { getActivityDays, getCurrentStreak } from '@/lib/activity'
import { useTodayInTimezone } from '@/hooks/useTodayInTimezone'

export default function HabitStreak() {
  const t = useTranslations('HabitStreak');
  const [settings] = useAtom(settingsAtom)
  const [hasTasks] = useAtom(hasTasksAtom)
  const [completedHabitsMap] = useAtom(completedHabitsMapAtom)
  const today = useTodayInTimezone(settings.system.timezone)
  const currentDay = DateTime.fromISO(today, { zone: settings.system.timezone })
  const completions = getActivityDays(completedHabitsMap, currentDay, 7)
  const currentStreak = getCurrentStreak(completedHabitsMap, currentDay)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dailyCompletionStreakTitle')}</CardTitle>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Flame className="h-4 w-4 text-orange-600 dark:text-orange-400" aria-hidden="true" />
          {t('currentStreak', { count: currentStreak })}
        </p>
      </CardHeader>
      <CardContent>
        <div className="w-full aspect-[2/1]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={completions}
              margin={{
                top: 5,
                right: 30,
                left: 20,
                bottom: 5,
              }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fill: 'hsl(var(--foreground))' }} />
              <YAxis allowDecimals={false} tick={{ fill: 'hsl(var(--foreground))' }} />
              <Tooltip
                labelFormatter={label => DateTime.fromISO(String(label), { zone: settings.system.timezone })
                  .setLocale(settings.system.language).toLocaleString(DateTime.DATE_FULL)}
                formatter={(value, name) => [`${value} ${name}`, t('tooltipCompletedLabel')]}
              />
              <Line
                type="monotone"
                name={t('tooltipHabitsLabel')}
                dataKey="habits"
                stroke="#14b8a6"
                strokeWidth={2}
                dot={false}
              />
              {hasTasks && (
                <Line
                  type="monotone"
                  name={t('tooltipTasksLabel')}
                  dataKey="tasks"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
