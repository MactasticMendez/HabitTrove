import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { DateTime, DateTimeFormatOptions } from "luxon"
import { datetime, RRule } from 'rrule'
import { Freq, Habit, CoinTransaction, Permission, ParsedFrequencyResult, ParsedResultType, User, Settings, HabitsData, CoinsData, WishlistData, UserData, PublicUserData } from '@/lib/types'
import { DUE_MAP, INITIAL_DUE, RECURRENCE_RULE_MAP } from "./constants"
import * as chrono from 'chrono-node'
import _ from "lodash"
import { v4 as uuidv4 } from 'uuid'
import stableStringify from 'json-stable-stringify';
import { getTaskMissedDates, isCountedCompletion, isTaskScheduledOnDate } from './task-schedule'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// get today's date string for timezone
export function getTodayInTimezone(timezone: string): string {
  const now = getNow({ timezone });
  return getISODate({ dateTime: now, timezone });
}

export function millisecondsUntilNextDay(timezone: string, now: DateTime = DateTime.now()): number {
  const zonedNow = now.setZone(timezone)
  return zonedNow.plus({ days: 1 }).startOf('day').toMillis() - zonedNow.toMillis()
}

// DayPicker works with browser-local Date values; keep the configured calendar day as a floating date.
export function toCalendarPickerDate(date: DateTime): Date {
  return new Date(date.year, date.month - 1, date.day, 12)
}

export function fromCalendarPickerDate(date: Date, timezone: string): DateTime {
  return DateTime.fromObject({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }, { zone: timezone })
}

// round a number to the nearest integer
export function roundToInteger(value: number): number {
  return Math.round(value);
}

export function getISODate({ dateTime, timezone }: { dateTime: DateTime, timezone: string }): string {
  return dateTime.setZone(timezone).toISODate()!;
}

// get datetime object of now
export function getNow({ timezone = 'utc', keepLocalTime }: { timezone?: string, keepLocalTime?: boolean }) {
  return DateTime.now().setZone(timezone, { keepLocalTime });
}

// get current time in epoch milliseconds
export function getNowInMilliseconds() {
  const now = getNow({});
  return d2n({ dateTime: now });
}

// iso timestamp to datetime object, most for storage read
export function t2d({ timestamp, timezone }: { timestamp: string; timezone: string }) {
  return DateTime.fromISO(timestamp).setZone(timezone);
}

// convert datetime object to iso timestamp, mostly for storage write (be sure to use default utc timezone when writing)
export function d2t({ dateTime, timezone = 'utc' }: { dateTime: DateTime, timezone?: string }) {
  return dateTime.setZone(timezone).toISO()!;
}

// convert datetime object to string, mostly for display
export function d2s({ dateTime, format, timezone }: { dateTime: DateTime, format?: string | DateTimeFormatOptions, timezone: string }) {
  if (format) {
    if (typeof format === 'string') {
      return dateTime.setZone(timezone).toFormat(format);
    } else {
      return dateTime.setZone(timezone).toLocaleString(format);
    }
  }
  return dateTime.setZone(timezone).toLocaleString(DateTime.DATETIME_MED);
}

// convert datetime object to date string, mostly for display
export function d2sDate({ dateTime }: { dateTime: DateTime }) {
  return dateTime.toLocaleString(DateTime.DATE_MED);
}

// convert datetime object to epoch milliseconds string, mostly for storage write
export function d2n({ dateTime }: { dateTime: DateTime }) {
  return dateTime.toMillis().toString();
}

// compare the date portion of two datetime objects (i.e. same year, month, day)
export function isSameDate(a: DateTime, b: DateTime) {
  return a.hasSame(b, 'day');
}

export function normalizeCompletionDate(date: string, timezone: string): string {
  // If already in ISO format, return as is
  if (date.includes('T')) {
    return date;
  }
  // Convert from yyyy-MM-dd to ISO format
  return DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: timezone }).toUTC().toISO()!;
}

export function getCompletionsForDate({
  habit,
  date,
  timezone
}: {
  habit: Habit,
  date: DateTime | string,
  timezone: string
}): number {
  const dateObj = typeof date === 'string' ? DateTime.fromISO(date) : date
  return habit.completions.filter((completion: string, index) =>
    isCountedCompletion(habit, index) && isSameDate(t2d({ timestamp: completion, timezone }), dateObj)
  ).length
}

export function getUndoableCompletionIndex(habit: Habit, userId: string | undefined, date: DateTime, timezone: string): number {
  if (!userId) return -1
  const day = date.setZone(timezone).toISODate()
  const index = habit.completions.findLastIndex((timestamp, completionIndex) =>
    isCountedCompletion(habit, completionIndex) &&
    DateTime.fromISO(timestamp, { setZone: true }).setZone(timezone).toISODate() === day)
  if (index < 0) return -1
  const record = habit.completionRecords?.[index]
  if (record) return record.actorId === userId ? index : -1
  return habit.userIds?.length === 1 && habit.userIds[0] === userId ? index : -1
}

export function getCompletionsForToday({
  habit,
  timezone
}: {
  habit: Habit,
  timezone: string
}): number {
  return getCompletionsForDate({ habit, date: getTodayInTimezone(timezone), timezone })
}

export function getCompletedHabitsForDate({
  habits,
  date,
  timezone
}: {
  habits: Habit[],
  date: DateTime | string,
  timezone: string
}): Habit[] {
  return habits.filter(habit => {
    const completionsToday = getCompletionsForDate({ habit, date, timezone })
    const target = habit.targetCompletions || 1
    return completionsToday >= target
  })
}

export function getHabitProgress({
  habit,
  timezone
}: {
  habit: Habit,
  timezone: string
}): number {
  const today = getTodayInTimezone(timezone)
  const completionsToday = getCompletionsForDate({ habit, date: today, timezone })
  const target = habit.targetCompletions || 1
  return Math.min(100, (completionsToday / target) * 100)
}

export function calculateCoinsEarnedToday(transactions: CoinTransaction[], timezone: string): number {
  const today = getTodayInTimezone(timezone);
  return transactions
    .filter(transaction =>
      isSameDate(t2d({ timestamp: transaction.timestamp, timezone }),
        t2d({ timestamp: today, timezone })) &&
      (transaction.amount > 0 || transaction.type === 'HABIT_UNDO')
    )
    .reduce((sum, transaction) => sum + transaction.amount, 0);
}

export function calculateTotalEarned(transactions: CoinTransaction[]): number {
  return transactions
    .filter(transaction =>
      transaction.amount > 0 || transaction.type === 'HABIT_UNDO'
    )
    .reduce((sum, transaction) => sum + transaction.amount, 0);
}

export function calculateTotalSpent(transactions: CoinTransaction[]): number {
  return Math.abs(
    transactions
      .filter(transaction =>
        transaction.amount < 0 &&
        transaction.type !== 'HABIT_UNDO'
      )
      .reduce((sum, transaction) => sum + transaction.amount, 0)
  );
}

export function filterCoinTransactions(transactions: CoinTransaction[], filter: 'all' | 'redemptions'): CoinTransaction[] {
  return filter === 'redemptions'
    ? transactions.filter(transaction => transaction.type === 'WISH_REDEMPTION')
    : transactions
}

export function calculateCoinsSpentToday(transactions: CoinTransaction[], timezone: string): number {
  const today = getTodayInTimezone(timezone);
  return Math.abs(
    transactions
      .filter(transaction =>
        isSameDate(t2d({ timestamp: transaction.timestamp, timezone }),
          t2d({ timestamp: today, timezone })) &&
        transaction.amount < 0 &&
        transaction.type !== 'HABIT_UNDO'
      )
      .reduce((sum, transaction) => sum + transaction.amount, 0)
  );
}

export function calculateTransactionsToday(transactions: CoinTransaction[], timezone: string): number {
  const today = getTodayInTimezone(timezone);
  return transactions.filter(t =>
    isSameDate(t2d({ timestamp: t.timestamp, timezone }),
      t2d({ timestamp: today, timezone }))
  ).length;
}

// Enhanced validation for weekly/monthly rules
function validateRecurrenceRule(rrule: RRule | null): ParsedFrequencyResult {
  if (!rrule) {
    return { result: null, message: 'Invalid recurrence rule.' };
  }

  const unsupportedReason = getUnsupportedRRuleReason(rrule);
  if (unsupportedReason) {
    return { result: rrule, message: unsupportedReason };
  }

  const options = rrule.origOptions;

  if (options.freq === RRule.WEEKLY && (!options.byweekday || !Array.isArray(options.byweekday) || options.byweekday.length === 0)) {
    return { result: null, message: 'Please specify day(s) of the week (e.g., "every week on Mon, Wed").' };
  }

  if (options.freq === RRule.MONTHLY &&
    (!options.bymonthday || !Array.isArray(options.bymonthday) || options.bymonthday.length === 0) &&
    (!options.bysetpos || !Array.isArray(options.bysetpos) || options.bysetpos.length === 0) && // Need to check bysetpos for rules like "last Friday"
    (!options.byweekday || !Array.isArray(options.byweekday) || options.byweekday.length === 0)) { // Need byweekday with bysetpos
    return { result: null, message: 'Please specify day of the month (e.g., "every month on the 15th") or position (e.g., "every month on the last Friday").' };
  }

  return { result: rrule, message: null };
}

// Convert a human-readable frequency (recurring or non-recurring) into a machine-readable one
export function convertHumanReadableFrequencyToMachineReadable({ text, timezone, isRecurring = false }: { text: string, timezone: string, isRecurring?: boolean }): ParsedFrequencyResult {
  text = text.trim()

  if (!isRecurring) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const date = DateTime.fromISO(text, { zone: timezone }).startOf('day')
      return date.isValid ? { result: date, message: null } : { result: null, message: 'Invalid due date.' }
    }
    if (DUE_MAP[text]) {
      text = DUE_MAP[text]
    }
    const now = getNow({ timezone })
    const due = chrono.parseDate(text, { instant: now.toJSDate(), timezone })
    if (!due) return { result: null, message: 'Invalid due date.' }
    const result = due ? DateTime.fromJSDate(due).setZone(timezone) : null
    return { message: null, result: result ? (result.isValid ? result : null) : null }
  }

  let rrule: RRule | null
  if (RECURRENCE_RULE_MAP[text]) {
    rrule = deserializeRRule(RECURRENCE_RULE_MAP[text])
  } else if (text.toLowerCase() === 'weekdays') {
    // Handle 'weekdays' specifically if not in the map
    rrule = new RRule({
      freq: RRule.WEEKLY,
      byweekday: [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR]
    });
  } else {
    try {
      rrule = RRule.fromText(text)
    } catch (error) {
      rrule = null
    }
  }
  if (rrule?.origOptions.freq === RRule.DAILY && (rrule.origOptions.interval ?? 1) > 1 && !rrule.origOptions.dtstart) {
    const start = getNow({ timezone }).startOf('day')
    rrule = new RRule({
      ...rrule.origOptions,
      dtstart: datetime(start.year, start.month, start.day),
      tzid: timezone,
    })
  }
  return validateRecurrenceRule(rrule);
}

// convert a machine-readable rrule **string** to an rrule object
export function deserializeRRule(rruleStr: string): RRule | null {
  try {
    return RRule.fromString(rruleStr);
  } catch (error) {
    return null;
  }
}

// convert a machine-readable rrule **object** to an rrule string
export function serializeRRule(rrule: RRule | null): string {
  if (!rrule) return 'invalid'; // Handle null case explicitly
  return rrule.toString()
}

// Convert a machine-readable frequency (recurring or non-recurring) into a human-readable one
export function convertMachineReadableFrequencyToHumanReadable({
  frequency,
  isRecurRule,
  timezone
}: {
  frequency: ParsedResultType,
  isRecurRule: boolean,
  timezone: string
}): string {
  if (isRecurRule) {
    if (!frequency) {
      return 'invalid'; // Handle null/undefined for recurring rules
    }
    if (frequency instanceof RRule) {
      return frequency.toText();
    } else if (typeof frequency === "string") {
      const parsedResult = deserializeRRule(frequency);
      return parsedResult?.toText() || 'invalid';
    } else {
      return 'invalid';
    }
  } else {
    // Handle non-recurring frequency
    if (!frequency) {
      // Use the imported constant for initial due date text
      return INITIAL_DUE;
    }
    if (typeof frequency === 'string') {
      return d2s({
        dateTime: t2d({ timestamp: frequency, timezone: timezone }),
        timezone: timezone,
        format: DateTime.DATE_MED_WITH_WEEKDAY
      });
    } else if (frequency instanceof DateTime) {
      return d2s({
        dateTime: frequency,
        timezone: timezone,
        format: DateTime.DATE_MED_WITH_WEEKDAY
      });
    } else {
      return 'invalid';
    }
  }
}

export function isHabitDue({
  habit,
  timezone,
  date
}: {
  habit: Habit
  timezone: string
  date: DateTime
}): boolean {
  // handle task
  if (habit.isTask) {
    return !habit.archived && isTaskScheduledOnDate(habit, date, timezone)
  }

  // handle habit
  if (habit.archived) {
    return false
  }

  const startOfDay = date.setZone(timezone).startOf('day')
  const endOfDay = date.setZone(timezone).endOf('day')

  const ruleText = habit.frequency
  const rrule = deserializeRRule(ruleText)
  if (!rrule) return false
  if (getUnsupportedRRuleReason(rrule)) return false
  const interval = rrule.origOptions.interval ?? 1
  if (rrule.origOptions.freq === RRule.DAILY && interval > 1) {
    const start = rrule.origOptions.dtstart!
    const firstDay = DateTime.fromObject({
      year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate(),
    }, { zone: timezone }).startOf('day')
    const days = Math.round(startOfDay.diff(firstDay, 'days').days)
    return days >= 0 && days % interval === 0
  }
  rrule.origOptions.tzid = timezone
  rrule.options.tzid = rrule.origOptions.tzid
  rrule.origOptions.dtstart = datetime(startOfDay.year, startOfDay.month, startOfDay.day, startOfDay.hour, startOfDay.minute, startOfDay.second)
  rrule.options.dtstart = rrule.origOptions.dtstart
  rrule.origOptions.count = 1
  rrule.options.count = rrule.origOptions.count

  const matches = rrule.all()
  if (!matches.length) return false
  const t = DateTime.fromJSDate(matches[0]).toUTC().setZone('local', { keepLocalTime: true }).setZone(timezone)
  return startOfDay <= t && t <= endOfDay
}

export function isHabitCompleted(habit: Habit, timezone: string): boolean {
  return getCompletionsForToday({ habit, timezone: timezone }) >= (habit.targetCompletions || 1)
}

export function isTaskOverdue(habit: Habit, timezone: string): boolean {
  if (!habit.isTask || habit.archived) return false
  return getTaskMissedDates(habit, getNow({ timezone }), timezone).length > 0
}

export function isHabitDueToday({
  habit,
  timezone
}: {
  habit: Habit
  timezone: string
}): boolean {
  const today = getNow({ timezone })
  return isHabitDue({ habit, timezone, date: today })
}

export function getHabitFreq(habit: Habit): Freq {
  if (habit.isTask) {
    return habit.taskRepeat ?? 'daily'
  }
  const rrule = deserializeRRule(habit.frequency)
  if (!rrule) return 'daily'
  const freq = rrule.origOptions.freq
  switch (freq) {
    case RRule.DAILY: return 'daily'
    case RRule.WEEKLY: return 'weekly'
    case RRule.MONTHLY: return 'monthly'
    case RRule.YEARLY: return 'yearly'

    default:
      console.error(`Invalid frequency: ${freq} (habit: ${habit.id} ${habit.name}) (rrule: ${rrule.toString()}). Defaulting to daily`)
      return 'daily'
  }
}

/**
 * Checks if an RRule is unsupported and returns the reason.
 * @param rrule The RRule object to check.
 * @returns A string message explaining why the rule is unsupported, or null if it's supported.
 */
export const EXCESSIVE_RRULE_TIMES_REASON = 'Recurrence rules with more than 256 times per day are not supported.'

export function getUnsupportedRRuleReason(rrule: RRule): string | null {
  const freq = rrule.origOptions.freq;
  const interval = rrule.origOptions.interval || 1; // RRule defaults interval to 1
  const timeCombinations = (rrule.options.byhour?.length ?? 1) *
    (rrule.options.byminute?.length ?? 1) * (rrule.options.bysecond?.length ?? 1)

  if (timeCombinations > 256) {
    return EXCESSIVE_RRULE_TIMES_REASON;
  }

  if (freq === RRule.HOURLY) {
    return 'Hourly frequency is not supported.';
  }
  if (freq === RRule.MINUTELY) {
    return 'Minutely frequency is not supported.';
  }
  if (freq === RRule.SECONDLY) {
    return 'Secondly frequency is not supported.';
  }
  if (freq === RRule.DAILY && interval > 1 &&
      (interval > 365 || !rrule.origOptions.dtstart || rrule.origOptions.count || rrule.origOptions.until ||
        rrule.origOptions.byweekday || rrule.origOptions.bymonthday || rrule.origOptions.bymonth)) {
    return 'Every-N-days rules need a start date, an interval at most 365, and no extra filters.';
  }

  return null; // Rule is supported
}


// play sound (client side only, must be run in browser)
export const playSound = (soundPath: string = '/sounds/timer-end.wav') => {
  const audio = new Audio(soundPath)
  audio.play().catch(error => {
    console.error('Error playing sound:', error)
  })
}

// open a new window (client side only, must be run in browser)
export const openWindow = (url: string): boolean => {
  let safeUrl: URL
  try { safeUrl = new URL(url) } catch { return false }
  if (!['http:', 'https:'].includes(safeUrl.protocol) || safeUrl.username || safeUrl.password) return false
  try {
    // With noopener, browsers may return null even after opening the new tab.
    window.open(safeUrl.href, '_blank', 'noopener,noreferrer')
    return true
  } catch {
    return false
  }
}

export function deepMerge<T>(a: T, b: T) {
  return _.merge(a, b, (x: unknown, y: unknown) => {
    if (_.isArray(a)) {
      return a.concat(b)
    }
  })
}

export function checkPermission(
  permissions: Permission[] | undefined,
  resource: 'habit' | 'wishlist' | 'coins',
  action: 'write' | 'interact'
): boolean {
  if (!permissions) return false

  return permissions.some(permission => {
    switch (resource) {
      case 'habit':
        return permission.habit[action]
      case 'wishlist':
        return permission.wishlist[action]
      case 'coins':
        return permission.coins[action]
      default:
        return false
    }
  })
}

export function uuid() {
  return uuidv4()
}

export function hasPermission(
  currentUser: User | undefined,
  resource: 'habit' | 'wishlist' | 'coins',
  action: 'write' | 'interact'
): boolean {
  // If no current user, no permissions.
  if (!currentUser) {
    return false;
  }
  // If user is admin, they have all permissions.
  if (currentUser.isAdmin) {
    return true;
  }
  // Otherwise, check specific permissions.
  return checkPermission(currentUser.permissions, resource, action);
}

/**
 * Prepares a consistent string representation of the data for hashing.
 * It combines all relevant data pieces into a single object and then stringifies it stably.
 */
export function prepareDataForHashing(
  settings: Settings,
  habits: HabitsData,
  coins: CoinsData,
  wishlist: WishlistData,
  users: UserData | PublicUserData
): string {
  // Combine all data into a single object.
  // The order of keys in this object itself doesn't matter due to stableStringify,
  // but being explicit helps in understanding what's being hashed.
  const combinedData = {
    settings,
    habits,
    coins,
    wishlist,
    users,
  };
  const stringifiedData = stableStringify(combinedData);
  // Handle cases where stringify might return undefined.
  if (stringifiedData === undefined) {
    throw new Error("Failed to stringify data for hashing. stableStringify returned undefined.");
  }
  return stringifiedData;
}

/**
 * Generates a SHA-256 hash for a given string using the Web Crypto API.
 * This function is suitable for both client-side and server-side (Node.js 19+) environments.
 * @param dataString The string to hash.
 * @returns A promise that resolves to the hex string of the hash.
 */
export async function generateCryptoHash(dataString: string): Promise<string | null> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(dataString);
    // globalThis.crypto should be available in modern browsers and Node.js (v19+)
    // For Node.js v15-v18, you might need: const { subtle } = require('node:crypto').webcrypto;
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    // Convert buffer to hex string
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  } catch (error) {
    console.error(`Failed to generate hash: ${error}`);
    return null;
  }
}
