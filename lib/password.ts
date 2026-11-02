import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

export function saltAndHashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  if (!password) throw new Error('Password must not be empty')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

export function verifyPassword(password?: string, storedHash?: string): boolean {
  if (!password || !storedHash) return false

  const match = /^([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(storedHash)
  if (!match) return false
  const actual = scryptSync(password, match[1], 64)
  return timingSafeEqual(actual, Buffer.from(match[2], 'hex'))
}
