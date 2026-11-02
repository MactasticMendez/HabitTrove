import 'server-only'
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { getDefaultUsersData, type User, type UserData } from './types'
import { saltAndHashPassword, verifyPasswordAsync } from './password'
import { emailSchema, newPasswordSchema } from './zod'
import { getLegacyOidcIssuer } from './admin-config'

const failedLogins = new Map<string, { count: number; until: number }>()
const failedStepUps = new Map<string, { count: number; until: number }>()
const loginWindowMs = 15 * 60 * 1000
const maxFailedLogins = 10
const maxConcurrentLoginVerifications = 4
const dummyHash = saltAndHashPassword('invalid-user-placeholder')
let activePasswordVerifications = 0
let writeQueue: Promise<void> = Promise.resolve()

function authPath(): string {
  return path.join(process.cwd(), 'data', 'auth.json')
}

function parseAuthData(raw: string): UserData {
  const data: unknown = JSON.parse(raw)
  if (!data || typeof data !== 'object' || !('users' in data) ||
      !Array.isArray(data.users) || data.users.some((user: unknown) =>
        !user || typeof user !== 'object' ||
        typeof (user as User).id !== 'string' ||
        typeof (user as User).username !== 'string' ||
        ((user as User).isAdmin !== undefined && typeof (user as User).isAdmin !== 'boolean'))) {
    throw new Error('Invalid account data')
  }
  return data as UserData
}

export async function readAuthData(): Promise<UserData> {
  const file = authPath()
  try {
    return parseAuthData(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const initial = getDefaultUsersData()
  if (process.env.DEMO !== 'true') {
    const password = process.env.INITIAL_ADMIN_PASSWORD
    const email = process.env.INITIAL_ADMIN_EMAIL
    if (!password || !newPasswordSchema.safeParse(password).success) {
      throw new Error('INITIAL_ADMIN_PASSWORD must be 12-128 characters for a new installation')
    }
    if (!email || !emailSchema.safeParse(email).success) {
      throw new Error('INITIAL_ADMIN_EMAIL must be a valid email for a new installation')
    }
    initial.users[0].password = saltAndHashPassword(password)
    initial.users[0].email = email.toLowerCase()
    initial.users[0].authVersion = 0
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(file, JSON.stringify(initial, null, 2), { flag: 'wx', mode: 0o600 })
    return initial
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return parseAuthData(await fs.readFile(file, 'utf8'))
  }
}

export async function updateAuthData<T>(update: (data: UserData) => T | Promise<T>): Promise<T> {
  const prior = writeQueue
  let release: () => void = () => {}
  writeQueue = new Promise<void>(resolve => { release = resolve })
  await prior
  try {
    const data = await readAuthData()
    const result = await update(data)
    const file = authPath()
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return result
  } finally {
    release()
  }
}

export async function findUserById(id: string): Promise<User | undefined> {
  return (await readAuthData()).users.find(user => user.id === id)
}

export async function userMatchesOidcIdentity(user: User, subject: string, issuer: string): Promise<boolean> {
  if (user.authentikSubject !== subject) return false
  if (user.oidcIssuer) return user.oidcIssuer === issuer
  return (await getLegacyOidcIssuer()) === issuer
}

export async function findUserByAuthentikSubject(subject: string, issuer: string): Promise<User | undefined> {
  const legacyIssuer = await getLegacyOidcIssuer()
  const matches = (await readAuthData()).users.filter(user =>
    user.authentikSubject === subject && (user.oidcIssuer === issuer || (!user.oidcIssuer && legacyIssuer === issuer)))
  if (matches.length > 1) throw new Error('Duplicate OIDC identity')
  return matches[0]
}

export async function linkUserToAuthentikSubject(
  userId: string,
  authVersion: number,
  verifiedEmail: string,
  subject: string,
  issuer: string,
): Promise<User> {
  return updateAuthData(data => {
    const user = data.users.find(candidate => candidate.id === userId)
    if (!user || (user.authVersion ?? 0) !== authVersion ||
        !user.email || user.email.toLowerCase() !== verifiedEmail || user.authentikSubject) {
      throw new Error('Account link is no longer valid')
    }
    if (data.users.some(candidate => candidate.authentikSubject === subject)) {
      throw new Error('OIDC identity is already linked')
    }
    user.authentikSubject = subject
    user.oidcIssuer = issuer
    user.authVersion = authVersion + 1
    return user
  })
}

export async function authenticateLocalUser(username: string, password: string): Promise<User | null> {
  if (activePasswordVerifications >= maxConcurrentLoginVerifications) return null
  activePasswordVerifications++
  try {
    const user = (await readAuthData()).users.find(candidate => candidate.username === username)
    if (!user) {
      await verifyPasswordAsync(password, dummyHash)
      return null
    }
    const now = Date.now()
    const attempts = failedLogins.get(user.id)
    if (attempts && attempts.until > now && attempts.count >= maxFailedLogins) return null
    if (attempts && attempts.until <= now) failedLogins.delete(user.id)

    const valid = await verifyPasswordAsync(password, user.password || dummyHash)
    if (valid || process.env.DEMO === 'true' && !user.password && password === '') {
      failedLogins.delete(user.id)
      return user
    }
    const current = failedLogins.get(user.id)
    failedLogins.set(user.id, { count: (current?.count ?? 0) + 1, until: now + loginWindowMs })
    return null
  } finally {
    activePasswordVerifications--
  }
}

export async function verifyStepUpPassword(user: User, password: string): Promise<boolean> {
  if (activePasswordVerifications >= maxConcurrentLoginVerifications) return false
  activePasswordVerifications++
  try {
    const now = Date.now()
    const attempts = failedStepUps.get(user.id)
    if (attempts && attempts.until > now && attempts.count >= maxFailedLogins) return false
    if (attempts && attempts.until <= now) failedStepUps.delete(user.id)
    const valid = await verifyPasswordAsync(password, user.password)
    if (valid) {
      failedStepUps.delete(user.id)
      return true
    }
    const current = failedStepUps.get(user.id)
    failedStepUps.set(user.id, { count: (current?.count ?? 0) + 1, until: now + loginWindowMs })
    return false
  } finally {
    activePasswordVerifications--
  }
}
