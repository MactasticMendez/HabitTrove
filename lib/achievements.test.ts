import { describe, expect, test } from 'bun:test'
import { getAchievements } from './achievements'
import type { CoinTransaction } from './types'

describe('achievements', () => {
  test('counts awarded completions and redemptions without undo transactions', () => {
    const tx = (type: CoinTransaction['type']): CoinTransaction => ({
      id: type, amount: 1, type, description: '', timestamp: '2026-01-01T00:00:00Z',
    })
    const result = getAchievements([tx('HABIT_COMPLETION'), tx('TASK_COMPLETION'), tx('TASK_UNDO'), tx('WISH_REDEMPTION')])
    expect(result.map(item => item.earned)).toEqual([true, false, false, true, true])
  })
})
