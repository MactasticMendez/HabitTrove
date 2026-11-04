import { DateTime } from 'luxon'
import { RRule } from 'rrule'
import { EXCESSIVE_RRULE_TIMES_REASON, UNSAFE_RRULE_BOUNDS_REASON, getUnsupportedRRuleReason } from './utils'
import type { Habit, Settings, WishlistItemType } from './types'
import { MAX_COIN_LIMIT } from './constants'
import { z } from 'zod'

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  DateTime.fromISO(value).isValid && DateTime.fromISO(value).toISODate() === value)
const flexibleScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('afterCompletion'), interval: z.number().int().min(1).max(365),
    unit: z.enum(['days', 'weeks', 'months', 'years']), startsOn: calendarDate,
    endsOn: calendarDate.optional() }).strict(),
  z.object({ type: z.literal('anytime'), recordingPolicy: z.enum(['member', 'manager', 'both']) }).strict(),
])

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

export function validateHabit(habit: Habit, existingFrequency?: string): Habit {
  if (!habit || typeof habit.id !== 'string' || typeof habit.name !== 'string' ||
      habit.name.length > 200 || typeof habit.description !== 'string' || habit.description.length > 10_000 ||
      typeof habit.frequency !== 'string' || habit.frequency.length > 512 || !Array.isArray(habit.completions) ||
      habit.completions.length > 20_000) throw new Error('Invalid habit')
  validateReward(habit.coinReward)
  const schedule = habit.schedule === undefined ? undefined : flexibleScheduleSchema.parse(habit.schedule)
  if (schedule?.type === 'afterCompletion' && schedule.endsOn && schedule.endsOn < schedule.startsOn) {
    throw new Error('Schedule end must follow its start')
  }
  if (schedule && (habit.taskRepeat || habit.taskRepeatInterval !== undefined || habit.taskRepeatUntil !== undefined)) {
    throw new Error('Choose one schedule mode')
  }
  if (schedule?.type === 'anytime' && (habit.isTask || habit.isNegative || habit.userIds?.length !== 1 ||
      habit.targetCompletions !== undefined && habit.targetCompletions !== 1 || habit.reminderTime !== undefined)) {
    throw new Error('Any-time actions require one assignee and one completion per reward')
  }
  if (habit.isNegative !== undefined && typeof habit.isNegative !== 'boolean') throw new Error('Invalid negative habit')
  if (habit.coinPenalty !== undefined) {
    validateReward(habit.coinPenalty)
    if (!habit.isNegative) throw new Error('Coin penalty requires a negative habit')
  }
  if (habit.isNegative && (habit.isTask || habit.targetCompletions && habit.targetCompletions !== 1 ||
      habit.requiresApproval || habit.coinBoost || habit.userIds?.length !== 1)) throw new Error('Invalid negative habit settings')
  if (habit.slips !== undefined && (!habit.isNegative || !Array.isArray(habit.slips) || habit.slips.length > 20_000 ||
      new Set(habit.slips.map(slip => slip?.id)).size !== habit.slips.length || habit.slips.some(slip =>
        !slip || typeof slip.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(slip.id) ||
        typeof slip.actorId !== 'string' || slip.actorId.length > 128 ||
        typeof slip.timestamp !== 'string' || !DateTime.fromISO(slip.timestamp).isValid ||
        !Number.isSafeInteger(slip.penaltyAmount) || slip.penaltyAmount < 0 || slip.penaltyAmount > MAX_COIN_LIMIT))) {
    throw new Error('Invalid slip records')
  }
  if (habit.targetCompletions !== undefined && (!Number.isSafeInteger(habit.targetCompletions) ||
      habit.targetCompletions < 1 || habit.targetCompletions > 10_000)) throw new Error('Invalid completion target')
  if (habit.position !== undefined && (!Number.isSafeInteger(habit.position) || habit.position < 0 || habit.position > 100_000)) {
    throw new Error('Invalid habit position')
  }
  if (habit.taskRepeat !== undefined && (!habit.isTask || !['daily', 'weekly', 'monthly', 'yearly'].includes(habit.taskRepeat))) {
    throw new Error('Invalid task recurrence')
  }
  if (habit.taskRepeatInterval !== undefined && (!habit.taskRepeat || !Number.isSafeInteger(habit.taskRepeatInterval) ||
      habit.taskRepeatInterval < 1 || habit.taskRepeatInterval > 365)) throw new Error('Invalid task interval')
  if (habit.taskRepeatUntil !== undefined && (!habit.taskRepeat || !calendarDate.safeParse(habit.taskRepeatUntil).success)) {
    throw new Error('Invalid task end date')
  }
  if (habit.taskGoalOccurrences !== undefined && (!habit.isTask || !habit.taskRepeat && schedule?.type !== 'afterCompletion' ||
      !Number.isSafeInteger(habit.taskGoalOccurrences) || habit.taskGoalOccurrences < 1 || habit.taskGoalOccurrences > 1000)) {
    throw new Error('Invalid task goal')
  }
  if (habit.checklist !== undefined && (!habit.isTask || !Array.isArray(habit.checklist) || habit.checklist.length > 30 ||
      new Set(habit.checklist.map(item => item?.id)).size !== habit.checklist.length ||
      habit.checklist.some(item => !item || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(item.id) ||
        typeof item.text !== 'string' || !item.text.trim() || item.text.length > 200 || typeof item.completed !== 'boolean'))) {
    throw new Error('Invalid task checklist')
  }
  if (habit.reminderTime !== undefined && (typeof habit.reminderTime !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(habit.reminderTime))) throw new Error('Invalid reminder time')
  if (habit.requiresApproval !== undefined && typeof habit.requiresApproval !== 'boolean') {
    throw new Error('Invalid approval setting')
  }
  if (habit.createdBy !== undefined && (typeof habit.createdBy !== 'string' || habit.createdBy.length > 128)) {
    throw new Error('Invalid item creator')
  }
  if (habit.approverIds !== undefined && (!Array.isArray(habit.approverIds) || habit.approverIds.length > 20 ||
      new Set(habit.approverIds).size !== habit.approverIds.length ||
      habit.approverIds.some(id => typeof id !== 'string' || !id || id.length > 128))) {
    throw new Error('Invalid approvers')
  }
  if (habit.requiresApproval && !habit.approverIds?.length) throw new Error('Choose at least one approver')
  if (habit.coinBoost !== undefined && (!habit.coinBoost || ![2, 3].includes(habit.coinBoost.multiplier) ||
      typeof habit.coinBoost.startsAt !== 'string' || habit.coinBoost.startsAt.length > 64 ||
      !DateTime.fromISO(habit.coinBoost.startsAt, { setZone: true }).isValid ||
      typeof habit.coinBoost.until !== 'string' || habit.coinBoost.until.length > 64 ||
      !DateTime.fromISO(habit.coinBoost.until, { setZone: true }).isValid ||
      DateTime.fromISO(habit.coinBoost.until) <= DateTime.fromISO(habit.coinBoost.startsAt) ||
      habit.coinReward * habit.coinBoost.multiplier > MAX_COIN_LIMIT)) throw new Error('Invalid coin boost')
  if (habit.isTask) {
    if (!DateTime.fromISO(habit.frequency).isValid) throw new Error('Invalid task due date')
  } else {
    try {
      const rule = RRule.fromString(habit.frequency)
      const unsupportedReason = getUnsupportedRRuleReason(rule)
      if (unsupportedReason && !([EXCESSIVE_RRULE_TIMES_REASON, UNSAFE_RRULE_BOUNDS_REASON].includes(unsupportedReason) &&
          existingFrequency === habit.frequency)) throw new Error('Unsupported recurrence rule')
    } catch { throw new Error('Invalid recurrence rule') }
  }
  if (habit.completions.some(value => typeof value !== 'string' || value.length > 64 || !DateTime.fromISO(value).isValid)) {
    throw new Error('Invalid habit completion')
  }
  if (habit.completionRecords !== undefined &&
      (!Array.isArray(habit.completionRecords) || habit.completionRecords.length !== habit.completions.length ||
       habit.completionRecords.some(record => record !== null &&
         (!record || typeof record !== 'object' || typeof record.id !== 'string' || record.id.length > 128 ||
          typeof record.actorId !== 'string' || record.actorId.length > 128 ||
          record.beneficiaryId !== undefined && (typeof record.beneficiaryId !== 'string' || !record.beneficiaryId || record.beneficiaryId.length > 128) ||
          record.requestId !== undefined && (typeof record.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.requestId)) ||
          record.voided !== undefined && typeof record.voided !== 'boolean' ||
          record.autoArchived !== undefined && typeof record.autoArchived !== 'boolean' ||
          record.approval !== undefined && !['pending', 'approved', 'rejected'].includes(record.approval) ||
          record.rewardAmount !== undefined && (!Number.isSafeInteger(record.rewardAmount) ||
            record.rewardAmount < 0 || record.rewardAmount > MAX_COIN_LIMIT) ||
          record.rewardTarget !== undefined && (!Number.isSafeInteger(record.rewardTarget) ||
            record.rewardTarget < 1 || record.rewardTarget > 10_000) ||
          record.evidenceId !== undefined && (typeof record.evidenceId !== 'string' ||
            !/^[0-9a-f-]{36}$/i.test(record.evidenceId)) ||
          record.evidenceMime !== undefined && !['image/jpeg', 'image/png', 'image/webp'].includes(record.evidenceMime) ||
          record.reviewedBy !== undefined && (typeof record.reviewedBy !== 'string' || record.reviewedBy.length > 128) ||
          record.reviewedAt !== undefined && (typeof record.reviewedAt !== 'string' || record.reviewedAt.length > 64 ||
            !DateTime.fromISO(record.reviewedAt).isValid) ||
          record.rewardedUserIds !== undefined &&
            (!Array.isArray(record.rewardedUserIds) || record.rewardedUserIds.length > 100 ||
             record.rewardedUserIds.some(id => typeof id !== 'string' || id.length > 128)))))) {
    throw new Error('Invalid habit completion records')
  }
  validateDrawing(habit.drawing)
  return { ...habit, ...(schedule && { schedule }) }
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
