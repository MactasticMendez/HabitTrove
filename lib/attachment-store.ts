import 'server-only'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterStorageCommit, currentDatabaseClient, withStorageTransaction } from './db/client'
import { readAttachmentMetadata, removeAttachmentMetadata, upsertAttachmentMetadata, type AttachmentMetadata } from './db/repository'
import { withProtectedAssetCleanup } from './db-migration'
import { usesPostgres } from './storage-mode'
import { getFamiliesEnabled, withFamilyScope, withFreshFamilyActor } from './family-scope'
import { log } from './logger'
import type { User } from './types'

function attachmentPath(relativePath: string): string {
  if (!/^(avatars|evidence)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(relativePath)) {
    throw new Error('Invalid protected attachment path')
  }
  return path.join(process.cwd(), 'data', relativePath)
}

async function verifyDirectories(filename: string): Promise<void> {
  for (const directory of [path.join(process.cwd(), 'data'), path.dirname(filename)]) {
    const stats = await fs.lstat(directory)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Invalid protected attachment directory')
  }
}

async function withEvidenceMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const client = currentDatabaseClient()!
  const prior = (await client.query("SELECT current_setting('habittrove.evidence_maintenance',true) AS value")).rows[0].value
  await client.query("SELECT set_config('habittrove.evidence_maintenance','true',true)")
  try { return await operation() }
  finally { await client.query("SELECT set_config('habittrove.evidence_maintenance',$1,true)", [prior ?? '']).catch(() => undefined) }
}

// The caller has already authorized the item mutation in this same family transaction.
export async function scheduleHabitEvidenceRemoval(habitId: string, evidenceId: string, completionId: string, relativePath: string): Promise<void> {
  if (typeof habitId !== 'string' || !habitId || habitId.length > 255 || typeof completionId !== 'string' || !completionId || completionId.length > 255 ||
      typeof evidenceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(evidenceId) || typeof relativePath !== 'string' || !new RegExp(`^evidence/${evidenceId}\\.(jpg|png|webp)$`).test(relativePath)) {
    throw new Error('Invalid protected evidence identity')
  }
  attachmentPath(relativePath)
  if (!usesPostgres()) return scheduleAttachmentRemoval(evidenceId, relativePath)
  await withStorageTransaction(async () => {
    if (!await getFamiliesEnabled()) return scheduleAttachmentRemoval(evidenceId, relativePath)
    const client = currentDatabaseClient()!
    const scope = (await client.query("SELECT current_setting('habittrove.actor_id',true) AS actor_id,current_setting('habittrove.family_id',true) AS family_id,current_setting('habittrove.scope_validated',true) AS validated")).rows[0]
    if (!scope.actor_id || !scope.family_id || scope.validated !== 'true') throw new Error('Validated family context required')
    const removed = await withEvidenceMaintenance(() => client.query(`DELETE FROM attachments
      WHERE family_id=$1 AND habit_id=$2 AND completion_id=$3 AND id=$4 AND path=$5 RETURNING id`,
    [scope.family_id, habitId, completionId, evidenceId, relativePath]))
    if (removed.rowCount) await scheduleAttachmentRemoval(evidenceId, relativePath)
  })
}

export async function registerAttachment(input: Omit<AttachmentMetadata, 'sha256'> & { bytes: Uint8Array }): Promise<void> {
  if (!usesPostgres()) return
  const filename = attachmentPath(input.path)
  await verifyDirectories(filename)
  const stats = await fs.lstat(filename)
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Invalid protected attachment file')
  const { bytes, ...metadata } = input
  await upsertAttachmentMetadata({ ...metadata, sha256: createHash('sha256').update(bytes).digest('hex') })
}

export async function scheduleAttachmentRemoval(id: string, relativePath: string): Promise<void> {
  const filename = attachmentPath(relativePath)
  const removeFile = async () => {
    try {
      await verifyDirectories(filename)
      const stats = await fs.lstat(filename)
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Invalid protected attachment file')
      await fs.unlink(filename)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!usesPostgres()) {
    await withProtectedAssetCleanup(removeFile)
    return
  }
  await withStorageTransaction(async () => {
    const familiesEnabled = await getFamiliesEnabled()
    let cleanupActor: User | undefined
    let familyId: string | undefined
    if (familiesEnabled) {
      const client = currentDatabaseClient()!
      const settings = (await client.query("SELECT current_setting('habittrove.actor_id',true) AS actor_id,current_setting('habittrove.family_id',true) AS family_id")).rows[0]
      const account = settings.actor_id && (await client.query('SELECT id,username,auth_version FROM users WHERE id=$1', [settings.actor_id])).rows[0]
      if (account) cleanupActor = { id: account.id, username: account.username, authVersion: account.auth_version ?? 0 }
      familyId = settings.family_id || undefined
    }
    const existing = await readAttachmentMetadata(id)
    if (existing && existing.path !== relativePath) throw new Error('Protected attachment path mismatch')
    await removeAttachmentMetadata(id)
    const cleanup = () => withProtectedAssetCleanup(async () => {
      // Generated paths are immutable. Check retained metadata in the original authorized scope.
      const findRetained = () => currentDatabaseClient()!.query('SELECT 1 FROM attachments WHERE path=$1 LIMIT 1', [relativePath])
      const retained = familiesEnabled && relativePath.startsWith('evidence/')
        ? await withEvidenceMaintenance(findRetained) : await findRetained()
      if (!retained.rowCount) await removeFile()
    })
    await afterStorageCommit(async () => {
      try {
        if (!familiesEnabled) await cleanup()
        else if (!cleanupActor) throw new Error('Attachment cleanup requires an actor')
        else if (familyId) await withFamilyScope(cleanupActor, async scope => {
          if (!scope) throw new Error('Attachment cleanup requires a family')
          await cleanup()
        }, familyId)
        else await withFreshFamilyActor(cleanupActor, cleanup)
      } catch {
        // Retain an orphan on revoked access or filesystem failure; never retry a committed award.
        log('warn', 'Protected attachment cleanup deferred')
      }
    })
  })
}
