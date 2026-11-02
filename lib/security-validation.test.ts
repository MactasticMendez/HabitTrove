import { describe, expect, test } from 'bun:test'
import { safeExternalUrl, validateDrawing, validateHabit, validateSettings } from './security-validation'
import { getDefaultSettings, type Habit } from './types'

describe('shared data validation', () => {
  test('allows only ordinary external web links', () => {
    expect(safeExternalUrl('https://example.com/reward')).toBe('https://example.com/reward')
    expect(() => safeExternalUrl('javascript:alert(1)')).toThrow()
    expect(() => safeExternalUrl('https://user:pass@example.com')).toThrow()
  })

  test('rejects malformed drawings and habit schedules before sharing', () => {
    expect(() => validateDrawing('[{"color":"#000000","thickness":4,"points":null}]')).toThrow()
    const habit: Habit = { id: '1', name: 'Habit', description: '', frequency: 'FREQ=DAILY', coinReward: 1, completions: [] }
    expect(validateHabit(habit)).toEqual(habit)
    expect(() => validateHabit({ ...habit, frequency: 'FREQ=SECONDLY' })).toThrow()
    expect(() => validateHabit({ ...habit, frequency: 'bad' })).toThrow()
  })

  test('rejects unsupported language and timezone values', () => {
    const settings = getDefaultSettings()
    expect(() => validateSettings({ ...settings, system: { ...settings.system, language: '../bad' } })).toThrow()
    expect(() => validateSettings({ ...settings, system: { ...settings.system, timezone: 'invalid' } })).toThrow()
  })
})
