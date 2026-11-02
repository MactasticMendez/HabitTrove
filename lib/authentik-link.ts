import { createHmac, timingSafeEqual } from 'crypto'

export const authentikLinkCookie = 'habittrove-authentik-link'
const linkLifetimeMs = 5 * 60 * 1000

export type AuthentikLinkIntent = {
  userId: string
  authVersion: number
  email: string
  expiresAt: number
}

export function createAuthentikLinkIntent(
  userId: string,
  authVersion: number,
  email: string,
  secret: string,
  now = Date.now(),
): string {
  if (secret.length < 32) throw new Error('AUTH_SECRET is too short')
  const body = Buffer.from(JSON.stringify({ userId, authVersion, email, expiresAt: now + linkLifetimeMs })).toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function verifyAuthentikLinkIntent(value: string | undefined, secret: string, now = Date.now()): AuthentikLinkIntent | null {
  if (!value || value.length > 2048 || secret.length < 32) return null
  const parts = value.split('.')
  if (parts.length !== 2) return null
  const expected = createHmac('sha256', secret).update(parts[0]).digest()
  const received = Buffer.from(parts[1], 'base64url')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null

  try {
    const intent: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    if (!intent || typeof intent !== 'object') return null
    const parsed = intent as Partial<AuthentikLinkIntent>
    if (typeof parsed.userId !== 'string' || !parsed.userId ||
        !Number.isSafeInteger(parsed.authVersion) || (parsed.authVersion ?? -1) < 0 ||
        typeof parsed.email !== 'string' || !parsed.email ||
        typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now || parsed.expiresAt > now + linkLifetimeMs) return null
    return parsed as AuthentikLinkIntent
  } catch {
    return null
  }
}
