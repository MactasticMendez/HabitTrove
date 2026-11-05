import { describe, expect, test } from 'bun:test'
import { safeExternalUrl, validateDrawing, validateHabit, validateSettings } from './security-validation'
import { getDefaultSettings, type Habit } from './types'

describe('shared data validation', () => {
  test('allows only ordinary external web links', () => {
    expect(safeExternalUrl('https://example.test/reward')).toBe('https://example.test/reward')
    expect(() => safeExternalUrl('javascript:alert(1)')).toThrow()
    expect(() => safeExternalUrl('https://user:pass@example.test')).toThrow()
  })

  test('rejects malformed drawings and habit schedules before sharing', () => {
    expect(() => validateDrawing('[{"color":"#000000","thickness":4,"points":null}]')).toThrow()
    const habit: Habit = { id: '1', name: 'Habit', description: '', frequency: 'FREQ=DAILY', coinReward: 1, completions: [] }
    expect(validateHabit(habit)).toEqual(habit)
    expect(validateHabit({ ...habit, position: 2 }).position).toBe(2)
    expect(() => validateHabit({ ...habit, position: -1 })).toThrow('Invalid habit position')
    expect(() => validateHabit({ ...habit, position: Number.POSITIVE_INFINITY })).toThrow('Invalid habit position')
    expect(() => validateHabit({ ...habit, frequency: 'FREQ=DAILY;INTERVAL=2' })).toThrow('Invalid recurrence rule')
    expect(validateHabit({ ...habit, frequency: 'DTSTART:20260307T000000Z\nRRULE:FREQ=DAILY;INTERVAL=2' }).frequency)
      .toContain('INTERVAL=2')
    expect(() => validateHabit({ ...habit, frequency: 'FREQ=SECONDLY' })).toThrow()
    expect(() => validateHabit({ ...habit, frequency: 'bad' })).toThrow()
    expect(() => validateHabit({ ...habit, completionRecords: [{ id: 'record', actorId: 'member' }] }))
      .toThrow('Invalid habit completion records')
    expect(validateHabit({ ...habit, completionRecords: [] }).completionRecords).toEqual([])
    const crowdedTimes = `FREQ=DAILY;BYHOUR=${Array.from({ length: 24 }, (_, i) => i).join(',')};BYMINUTE=${Array.from({ length: 60 }, (_, i) => i).join(',')};BYSECOND=${Array.from({ length: 60 }, (_, i) => i).join(',')}`
    expect(() => validateHabit({ ...habit, frequency: crowdedTimes })).toThrow('Invalid recurrence rule')
    expect(validateHabit({ ...habit, frequency: crowdedTimes }, crowdedTimes).frequency).toBe(crowdedTimes)
    expect(() => validateHabit({ ...habit, frequency: crowdedTimes.replace('BYHOUR=0,', 'BYHOUR=1,') }, crowdedTimes))
      .toThrow('Invalid recurrence rule')
  })

  test('rejects unsupported language and timezone values', () => {
    const settings = getDefaultSettings()
    expect(() => validateSettings({ ...settings, system: { ...settings.system, language: '../bad' } })).toThrow()
    expect(() => validateSettings({ ...settings, system: { ...settings.system, timezone: 'invalid' } })).toThrow()
  })
})

describe('single-member habit ownership and retained archived history', () => {
  const item = (kind: 'anytime' | 'negative', archived: boolean, userIds: string[]): Habit => ({
    id: `${kind}-habit`, name: 'Retained habit', description: '', frequency: 'FREQ=DAILY',
    coinReward: 1, completions: [], archived, userIds,
    ...(kind === 'anytime' ? { schedule: { type: 'anytime', recordingPolicy: 'both' } } : { isNegative: true, coinPenalty: 1 }),
  })

  for (const kind of ['anytime', 'negative'] as const) for (const archived of [false, true]) {
    for (const count of [0, 1, 2]) test(`${archived ? 'archived' : 'active'} ${kind} habit with ${count} assignees`, () => {
      const habit = item(kind, archived, ['member', 'other'].slice(0, count))
      if (count === 1 || archived && count === 0) expect(validateHabit(habit)).toEqual(habit)
      else expect(() => validateHabit(habit)).toThrow()
    })
  }

  test('archived orphan allowance requires an explicit array and boolean archived state', () => {
    for (const kind of ['anytime', 'negative'] as const) {
      expect(() => validateHabit({ ...item(kind, true, []), userIds: undefined })).toThrow()
      expect(() => validateHabit({ ...item(kind, true, []), userIds: '' as unknown as string[] })).toThrow()
      expect(() => validateHabit({ ...item(kind, true, []), archived: 'true' as unknown as boolean })).toThrow()
    }
  })

  test('archived orphan any-time completions and negative slips retain historical actors and rewards unchanged', () => {
    const anytime: Habit = { ...item('anytime', true, []), completions: ['2026-01-01T12:00:00Z'],
      completionRecords: [{ id: 'original-completion', actorId: 'removed-member', beneficiaryId: 'removed-member',
        rewardAmount: 1, rewardedUserIds: ['removed-member'], approval: 'approved' }] }
    const negative: Habit = { ...item('negative', true, []), slips: [{
      id: '11111111-1111-4111-8111-111111111111', actorId: 'removed-member', timestamp: '2026-01-01T12:00:00Z', penaltyAmount: 1,
    }] }
    for (const habit of [anytime, negative]) {
      const original = structuredClone(habit)
      expect(validateHabit(habit)).toEqual(original)
      expect(habit).toEqual(original)
    }
  })

  test('archived orphan items still reject incompatible schedules, limits and malformed history', () => {
    const anytime = item('anytime', true, [])
    for (const patch of [{ isTask: true }, { isNegative: true }, { targetCompletions: 2 }, { reminderTime: '09:00' },
      { completionRecords: [{ id: 'unaligned-record', actorId: 'former-member' }] }]) {
      expect(() => validateHabit({ ...anytime, ...patch })).toThrow()
    }
    const negative = item('negative', true, [])
    for (const patch of [{ isTask: true }, { requiresApproval: true }, { targetCompletions: 2 }, { coinPenalty: -1 },
      { slips: [{ id: 'invalid', actorId: 'former-member', timestamp: 'invalid', penaltyAmount: 1 }] }]) {
      expect(() => validateHabit({ ...negative, ...patch })).toThrow()
    }
  })
})
