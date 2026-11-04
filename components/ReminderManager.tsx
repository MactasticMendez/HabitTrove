'use client'

import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { DateTime } from 'luxon'
import { browserSettingsAtom, currentUserAtom, habitsAtom, settingsAtom } from '@/lib/atoms'
import { reminderDueDate } from '@/lib/reminders'
import { useTranslations } from 'next-intl'
import { toast } from '@/hooks/use-toast'

export default function ReminderManager() {
  const browserSettings = useAtomValue(browserSettingsAtom)
  const user = useAtomValue(currentUserAtom)
  const habits = useAtomValue(habitsAtom).habits
  const timezone = useAtomValue(settingsAtom).system.timezone
  const t = useTranslations('Reminders')

  useEffect(() => {
    if (!browserSettings.remindersEnabled || !user) return
    const check = () => {
      const now = DateTime.now().setZone(timezone)
      for (const habit of habits) {
        if (!habit.userIds?.includes(user.id) || habit.schedule?.type === 'anytime') continue
        const date = reminderDueDate(habit, now, timezone, browserSettings.reminderLeadMinutes ?? 0)
        if (!date) continue
        const key = `habittrove-reminder:${user.id}:${habit.id}`
        if (localStorage.getItem(key) === date) continue
        localStorage.setItem(key, date)
        toast({ title: t('title'), description: t('body', { name: habit.name }) })
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(t('title'), { body: t('body', { name: habit.name }), tag: key })
        }
      }
    }
    check()
    const interval = window.setInterval(check, 30_000)
    return () => window.clearInterval(interval)
  }, [browserSettings.remindersEnabled, browserSettings.reminderLeadMinutes, habits, timezone, t, user])

  return null
}
