import { expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { NextIntlClientProvider } from 'next-intl'
import { DateTime } from 'luxon'
import { browserSettingsAtom, currentUserIdAtom, habitsAtom, settingsAtom, usersAtom } from '@/lib/atoms'
import { getDefaultSettings, type Habit } from '@/lib/types'
import messages from '@/messages/en.json'

mock.module('server-only', () => ({}))
const { default: HabitList } = await import('./HabitList')
const { default: DailyOverview } = await import('./DailyOverview')

function renderDailyOnly(isTask: boolean, overview = false) {
  const today = DateTime.now().toUTC().startOf('day')
  const base: Habit = {
    id: 'daily', name: 'Daily fixture', description: '', coinReward: 1, completions: [],
    frequency: isTask ? today.toISO()! : 'FREQ=DAILY', isTask, userIds: ['member'],
    ...(isTask ? { taskRepeat: 'daily' as const } : {}),
  }
  const habits: Habit[] = [base, {
    ...base, id: 'alternate', name: 'Alternate fixture', taskRepeatInterval: 2,
    frequency: isTask ? base.frequency : `DTSTART:${today.toFormat("yyyyMMdd'T'HHmmss'Z'")}\nRRULE:FREQ=DAILY;INTERVAL=2`,
  }, {
    ...base, id: 'relative', name: 'Monthly relative fixture', taskRepeat: undefined,
    schedule: { type: 'afterCompletion', interval: 1, unit: 'months', startsOn: today.toISODate()! },
  }, {
    ...base, id: 'daily-relative', name: 'Daily relative fixture', taskRepeat: undefined,
    schedule: { type: 'afterCompletion', interval: 1, unit: 'days', startsOn: today.toISODate()! },
  }, ...(isTask ? [{ ...base, id: 'one-off', name: 'One-off fixture', taskRepeat: undefined }] : [{
    ...base, id: 'anytime', name: 'Anytime fixture', schedule: { type: 'anytime' as const, recordingPolicy: 'member' as const },
  }])]
  const store = createStore()
  store.set(settingsAtom, { ...getDefaultSettings(), system: { ...getDefaultSettings().system, timezone: 'UTC' } })
  store.set(usersAtom, { users: [{ id: 'member', username: 'Example member', hasPassword: true, hasOidc: false }] })
  store.set(currentUserIdAtom, 'member')
  store.set(browserSettingsAtom, { ...store.get(browserSettingsAtom), viewType: isTask ? 'tasks' : 'habits', hideNonDaily: true, showFolders: false })
  store.set(habitsAtom, { habits })
  return renderToStaticMarkup(<Provider store={store}><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    {overview ? <DailyOverview habits={habits} wishlistItems={[]} coinBalance={0} /> : <HabitList />}
  </NextIntlClientProvider></Provider>)
}

for (const isTask of [false, true]) {
  for (const overview of [false, true]) {
    test(`Daily only excludes non-daily ${isTask ? 'tasks' : 'habits'} in ${overview ? 'Today' : 'the list'}`, () => {
      const html = renderDailyOnly(isTask, overview)
      expect(html.includes('Daily fixture')).toBe(true)
      expect(html.includes('Daily relative fixture')).toBe(true)
      expect(html.includes('Alternate fixture')).toBe(false)
      expect(html.includes('Monthly relative fixture')).toBe(false)
      if (isTask) expect(html.includes('One-off fixture')).toBe(true)
      else expect(html.includes('Anytime fixture')).toBe(false)
    })
  }
}
