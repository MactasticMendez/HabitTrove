'use client'

import { useAtomValue } from 'jotai'
import { coinsAtom } from '@/lib/atoms'
import { getAchievements } from '@/lib/achievements'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTranslations } from 'next-intl'

export default function Achievements() {
  const t = useTranslations('Achievements')
  const achievements = getAchievements(useAtomValue(coinsAtom).transactions)
  return <Card>
    <CardHeader><CardTitle>{t('title')}</CardTitle></CardHeader>
    <CardContent>
      <ul className="space-y-2">
        {achievements.map(item => <li key={item.id} className="flex justify-between gap-3 text-sm">
          <span className={item.earned ? 'font-semibold text-emerald-700 dark:text-emerald-300' : ''}>
            {item.earned ? '✓ ' : ''}{t(item.id)}
          </span>
          <span className="text-muted-foreground">{Math.min(item.current, item.target)}/{item.target}</span>
        </li>)}
      </ul>
    </CardContent>
  </Card>
}
