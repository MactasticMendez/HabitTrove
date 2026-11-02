import { DateTime } from 'luxon'
import { RRule } from 'rrule'
import { getUnsupportedRRuleReason } from './utils'
import type { Habit, Settings, WishlistItemType } from './types'
import { MAX_COIN_LIMIT } from './constants'

export const supportedLanguages = new Set(['ca', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'])

export function safeExternalUrl(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid external URL')
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('External URL must use HTTP or HTTPS without credentials')
  }
  return url.href
}

export function validateDrawing(value: unknown): void {
  if (value == null || value === '') return
  if (typeof value !== 'string' || value.length > 256_000) throw new Error('Invalid drawing')
  let strokes: unknown
  try { strokes = JSON.parse(value) } catch { throw new Error('Invalid drawing') }
  if (!Array.isArray(strokes) || strokes.length > 1000) throw new Error('Invalid drawing')
  let points = 0
  for (const stroke of strokes) {
    if (!stroke || typeof stroke !== 'object' ||
        typeof stroke.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(stroke.color) ||
        typeof stroke.thickness !== 'number' || !Number.isFinite(stroke.thickness) ||
        stroke.thickness < 1 || stroke.thickness > 50 || !Array.isArray(stroke.points)) {
      throw new Error('Invalid drawing')
    }
    points += stroke.points.length
    if (points > 20_000 || stroke.points.some((point: unknown) =>
      !point || typeof point !== 'object' ||
      !Number.isFinite((point as { x: number }).x) || !Number.isFinite((point as { y: number }).y) ||
      Math.abs((point as { x: number }).x) > 100_000 || Math.abs((point as { y: number }).y) > 100_000)) {
      throw new Error('Invalid drawing')
    }
  }
}

function validateReward(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COIN_LIMIT) throw new Error('Invalid coin value')
}

export function validateWishlistItem(item: WishlistItemType): WishlistItemType {
  if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' ||
      item.name.length > 200 || typeof item.description !== 'string' || item.description.length > 10_000) {
    throw new Error('Invalid reward')
  }
  validateReward(item.coinCost)
  if (item.coinCost === 0 || item.targetCompletions !== undefined &&
      (!Number.isSafeInteger(item.targetCompletions) || item.targetCompletions < 1 || item.targetCompletions > 10_000)) {
    throw new Error('Invalid reward limit')
  }
  validateDrawing(item.drawing)
  return { ...item, link: safeExternalUrl(item.link) }
}

export function validateHabit(habit: Habit): Habit {
  if (!habit || typeof habit.id !== 'string' || typeof habit.name !== 'string' ||
      habit.name.length > 200 || typeof habit.description !== 'string' || habit.description.length > 10_000 ||
      typeof habit.frequency !== 'string' || habit.frequency.length > 512 || !Array.isArray(habit.completions) ||
      habit.completions.length > 20_000) throw new Error('Invalid habit')
  validateReward(habit.coinReward)
  if (habit.targetCompletions !== undefined && (!Number.isSafeInteger(habit.targetCompletions) ||
      habit.targetCompletions < 1 || habit.targetCompletions > 10_000)) throw new Error('Invalid completion target')
  if (habit.isTask) {
    if (!DateTime.fromISO(habit.frequency).isValid) throw new Error('Invalid task due date')
  } else {
    try {
      const rule = RRule.fromString(habit.frequency)
      if (getUnsupportedRRuleReason(rule)) throw new Error('Unsupported recurrence rule')
    } catch { throw new Error('Invalid recurrence rule') }
  }
  if (habit.completions.some(value => typeof value !== 'string' || value.length > 64 || !DateTime.fromISO(value).isValid)) {
    throw new Error('Invalid habit completion')
  }
  validateDrawing(habit.drawing)
  return habit
}

export function validateSettings(value: Settings): Settings {
  if (!value || typeof value !== 'object' || !value.ui || !value.system || !value.profile ||
      typeof value.ui.useNumberFormatting !== 'boolean' || typeof value.ui.useGrouping !== 'boolean' ||
      typeof value.system.autoBackupEnabled !== 'boolean' ||
      !Number.isInteger(value.system.weekStartDay) || value.system.weekStartDay < 0 || value.system.weekStartDay > 6 ||
      !supportedLanguages.has(value.system.language) || typeof value.system.timezone !== 'string' ||
      value.system.timezone.length > 100) throw new Error('Invalid settings')
  try { new Intl.DateTimeFormat('en', { timeZone: value.system.timezone }) }
  catch { throw new Error('Invalid timezone') }
  return value
}
