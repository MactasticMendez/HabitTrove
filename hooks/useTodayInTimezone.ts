'use client'

import { useEffect, useState } from 'react'
import { getTodayInTimezone, millisecondsUntilNextDay } from '@/lib/utils'

export function useTodayInTimezone(timezone: string): string {
  const [today, setToday] = useState(() => getTodayInTimezone(timezone))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => setToday(getTodayInTimezone(timezone))
    const schedule = () => {
      timer = setTimeout(() => {
        refresh()
        schedule()
      }, millisecondsUntilNextDay(timezone) + 100)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer)
        refresh()
        schedule()
      }
    }

    refresh()
    schedule()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [timezone])

  return today
}
