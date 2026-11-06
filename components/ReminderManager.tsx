'use client'

import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { DateTime } from 'luxon'
import { browserSettingsAtom, currentUserAtom, habitsAtom } from '@/lib/atoms'
import { reminderDueDate } from '@/lib/reminders'
import { useTranslations } from 'next-intl'
import { toast } from '@/hooks/use-toast'
import { showBrowserNotification } from '@/lib/browser-notifications'
import { loadReminderData } from '@/app/actions/data'

export default function ReminderManager() {
  const browserSettings = useAtomValue(browserSettingsAtom)
  const user = useAtomValue(currentUserAtom)
  const familyId = useAtomValue(habitsAtom).familyId
  const userId = user?.id
  const t = useTranslations('Reminders')

  useEffect(() => {
    if (!browserSettings.remindersEnabled || !userId) return
    let disposed = false
    let checking = false
    const check = async () => {
      if (checking || disposed) return
      checking = true
      try {
        const data = await loadReminderData(familyId)
        if (disposed || !data || data.userId !== userId || data.familyId !== familyId) return
        const now = DateTime.now().setZone(data.timezone)
        for (const habit of data.habits) {
          if (!habit.userIds?.includes(userId) || habit.schedule?.type === 'anytime') continue
          const date = reminderDueDate(habit, now, data.timezone, browserSettings.reminderLeadMinutes ?? 0)
          if (!date) continue
          const key = `habittrove-reminder:${userId}:${habit.id}`
          if (localStorage.getItem(key) === date) continue
          localStorage.setItem(key, date)
          toast({ title: t('title'), description: t('body', { name: habit.name }) })
          showBrowserNotification(t('title'), { body: t('body', { name: habit.name }), tag: key })
        }
      } catch {
        // Never deliver cached private item names when current authorization cannot be checked.
      } finally { checking = false }
    }
    void check()
    const interval = window.setInterval(() => void check(), 30_000)
    return () => { disposed = true; window.clearInterval(interval) }
  }, [browserSettings.remindersEnabled, browserSettings.reminderLeadMinutes, familyId, t, userId])

  return null
}
