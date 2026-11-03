'use client'

import { useAtom } from 'jotai'
import { wishlistAtom, habitsAtom, browserSettingsAtom } from '@/lib/atoms'
import DailyOverview from './DailyOverview'
import HabitStreak from './HabitStreak'
import HabitHeatmap from './HabitHeatmap'
import CoinBalance from './CoinBalance'
// import { useHabits } from '@/hooks/useHabits' // useHabits is not used
import { useCoins } from '@/hooks/useCoins'
import { useTranslations } from 'next-intl';
import { ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Achievements from './Achievements'

const defaultOrder = ['coins', 'streak', 'today', 'heatmap', 'achievements']

export default function Dashboard() {
  const t = useTranslations('Dashboard');
  const [habitsData] = useAtom(habitsAtom)
  const habits = habitsData.habits
  const [browserSettings, setBrowserSettings] = useAtom(browserSettingsAtom)
  const { balance } = useCoins()
  const [wishlist] = useAtom(wishlistAtom)
  const wishlistItems = wishlist.items
  const order = [...new Set([...(browserSettings.dashboardOrder ?? []).filter(id => defaultOrder.includes(id)), ...defaultOrder])]
  const move = (index: number, direction: -1 | 1) => {
    const next = [...order]
    ;[next[index], next[index + direction]] = [next[index + direction], next[index]]
    setBrowserSettings(previous => ({ ...previous, dashboardOrder: next }))
  }
  const cards = {
    coins: <CoinBalance coinBalance={balance} />,
    streak: <HabitStreak />,
    today: <DailyOverview wishlistItems={wishlistItems} habits={habits} coinBalance={balance} />,
    heatmap: <HabitHeatmap />,
    achievements: <Achievements />,
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl xs:text-3xl font-bold">{t('title')}</h1>
      </div>
      <div className="columns-1 gap-6 xl:columns-2 2xl:columns-3">
        {order.map((id, index) => <section key={id} className="mb-6 inline-block w-full break-inside-avoid align-top">
          <div className="mb-1 flex justify-end gap-1" role="group" aria-label={t('reorderSection', { name: t(id) })}>
            <Button type="button" size="sm" variant="ghost" disabled={index === 0}
              aria-label={t('moveUp', { name: t(id) })} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" /></Button>
            <Button type="button" size="sm" variant="ghost" disabled={index === order.length - 1}
              aria-label={t('moveDown', { name: t(id) })} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" /></Button>
          </div>
          {cards[id as keyof typeof cards]}
        </section>)}
      </div>
    </div>
  )
}

