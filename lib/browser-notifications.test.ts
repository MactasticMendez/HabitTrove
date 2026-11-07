import { afterEach, expect, test } from 'bun:test'
import { getBrowserNotificationPermission, requestBrowserNotificationPermission, showBrowserNotification } from './browser-notifications'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function browser(permission: NotificationPermission = 'default', secure = true) {
  const calls = { requests: 0, shown: [] as string[] }
  class Notification {
    static permission = permission
    static async requestPermission(): Promise<NotificationPermission> {
      calls.requests++
      this.permission = 'granted'
      return this.permission
    }
    constructor(title: string) { calls.shown.push(title) }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: secure, Notification } })
  return { calls, Notification }
}

test('unavailable and insecure browser contexts keep permission and notification work disabled', async () => {
  Reflect.deleteProperty(globalThis, 'window')
  expect(getBrowserNotificationPermission()).toBe('unavailable')
  expect(await requestBrowserNotificationPermission()).toBe('unavailable')
  expect(showBrowserNotification('Test')).toBe(false)
  const { calls } = browser('default', false)
  expect(await requestBrowserNotificationPermission()).toBe('unavailable')
  expect(calls.requests).toBe(0)
})

test('permission inspection never prompts and explicit requests do not repeat an existing decision', async () => {
  const { calls } = browser()
  expect(getBrowserNotificationPermission()).toBe('default')
  expect(calls.requests).toBe(0)
  expect(showBrowserNotification('Before consent')).toBe(false)
  expect(await requestBrowserNotificationPermission()).toBe('granted')
  expect(await requestBrowserNotificationPermission()).toBe('granted')
  expect(calls.requests).toBe(1)
  expect(showBrowserNotification('Consented test')).toBe(true)
  expect(calls.shown).toEqual(['Consented test'])
})

test('denied permission is not requested again', async () => {
  const { calls } = browser('denied')
  expect(await requestBrowserNotificationPermission()).toBe('denied')
  expect(calls.requests).toBe(0)
  expect(showBrowserNotification('No consent')).toBe(false)
})

test('unsupported notification constructors cannot interrupt in-app reminders', () => {
  browser('granted')
  Object.defineProperty(window, 'Notification', { value: class {
    static permission = 'granted'
    constructor() { throw new TypeError('Constructor unavailable on this platform') }
  } })
  expect(showBrowserNotification('Test')).toBe(false)
})

test('permission request errors reach the UI without pretending permission was granted', async () => {
  const { Notification } = browser()
  Notification.requestPermission = async () => { throw new Error('Browser request failed') }
  await expect(requestBrowserNotificationPermission()).rejects.toThrow('Browser request failed')
  expect(getBrowserNotificationPermission()).toBe('default')
})

test('permission changes are read fresh without requesting or displaying after revocation', async () => {
  const { calls, Notification } = browser('granted')
  expect(showBrowserNotification('Before revocation')).toBe(true)
  Notification.permission = 'denied'
  expect(getBrowserNotificationPermission()).toBe('denied')
  expect(await requestBrowserNotificationPermission()).toBe('denied')
  expect(showBrowserNotification('After revocation')).toBe(false)
  expect(calls.requests).toBe(0)
  expect(calls.shown).toEqual(['Before revocation'])
})
