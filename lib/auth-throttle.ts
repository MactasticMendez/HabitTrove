import 'server-only'
import { createHash, randomUUID } from 'crypto'
import { usesPostgres } from './storage-mode'
import { currentDatabaseClient, withStorageTransaction } from './db/client'

const windowMs = 15 * 60 * 1000
const maxAttempts = 10
const maxVerifications = 4
const legacyAttempts = new Map<string, { attempts: number; expires: number }>()
let localVerifications = 0

type Purpose = 'login' | 'step-up' | 'invite'
function key(purpose: Purpose, userId: string): string {
  return createHash('sha256').update(JSON.stringify([purpose, userId])).digest('hex')
}

// Reserve before scrypt so concurrent requests cannot all pass the failure limit.
// Call only for an existing account or validated live invitation: unknown input never creates tracker rows.
export async function reserveAuthenticationAttempt(purpose: Purpose, userId: string): Promise<boolean> {
  const hash = key(purpose, userId)
  if (!usesPostgres()) {
    const now = Date.now()
    const current = legacyAttempts.get(hash)
    const attempts = current && current.expires > now ? current.attempts : 0
    if (attempts >= maxAttempts) return false
    legacyAttempts.set(hash, { attempts: attempts + 1, expires: now + windowMs })
    return true
  }
  return withStorageTransaction(async () => {
    const result = await currentDatabaseClient()!.query(`
      INSERT INTO authentication_throttles (key_hash, attempts, expires_at)
      VALUES ($1, 1, clock_timestamp() + interval '15 minutes')
      ON CONFLICT (key_hash) DO UPDATE SET
        attempts = CASE WHEN authentication_throttles.expires_at <= clock_timestamp() THEN 1 ELSE authentication_throttles.attempts + 1 END,
        expires_at = clock_timestamp() + interval '15 minutes'
      WHERE authentication_throttles.expires_at <= clock_timestamp() OR authentication_throttles.attempts < $2
      RETURNING key_hash`, [hash, maxAttempts])
    return result.rowCount === 1
  })
}

export async function clearAuthenticationAttempts(purpose: Purpose, userId: string): Promise<void> {
  const hash = key(purpose, userId)
  if (!usesPostgres()) { legacyAttempts.delete(hash); return }
  await withStorageTransaction(async () => {
    await currentDatabaseClient()!.query('DELETE FROM authentication_throttles WHERE key_hash=$1', [hash])
  })
}

export async function acquirePasswordVerification(): Promise<(() => Promise<void>) | undefined> {
  const postgres = usesPostgres()
  if (localVerifications >= maxVerifications) return undefined
  localVerifications++
  let slot: string | undefined
  const owner = randomUUID()
  try {
    if (postgres) {
      slot = await withStorageTransaction(async () => {
        for (let index = 0; index < maxVerifications; index++) {
          const name = `password-verification:${index}`
          const result = await currentDatabaseClient()!.query(`
            INSERT INTO job_leases (name, owner, expires_at) VALUES ($1,$2,clock_timestamp() + interval '60 seconds')
            ON CONFLICT (name) DO UPDATE SET owner=$2, expires_at=clock_timestamp() + interval '60 seconds'
            WHERE job_leases.expires_at <= clock_timestamp() RETURNING name`, [name, owner])
          if (result.rowCount) return name
        }
        return undefined
      })
      if (!slot) { localVerifications--; return undefined }
    }
  } catch (error) { localVerifications--; throw error }
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      if (postgres) await withStorageTransaction(async () => {
        await currentDatabaseClient()!.query('DELETE FROM job_leases WHERE name=$1 AND owner=$2', [slot, owner])
      })
    } finally { localVerifications-- }
  }
}
