import type { CoinTransaction } from './types'

export type Achievement = { id: string; earned: boolean; current: number; target: number }

export function getAchievements(transactions: CoinTransaction[]): Achievement[] {
  const completions = transactions.filter(item => item.type === 'HABIT_COMPLETION' || item.type === 'TASK_COMPLETION').length
  const tasks = transactions.filter(item => item.type === 'TASK_COMPLETION').length
  const redemptions = transactions.filter(item => item.type === 'WISH_REDEMPTION').length
  return [
    { id: 'firstCompletion', current: completions, target: 1 },
    { id: 'tenCompletions', current: completions, target: 10 },
    { id: 'hundredCompletions', current: completions, target: 100 },
    { id: 'firstTask', current: tasks, target: 1 },
    { id: 'firstRedemption', current: redemptions, target: 1 },
  ].map(item => ({ ...item, earned: item.current >= item.target }))
}
