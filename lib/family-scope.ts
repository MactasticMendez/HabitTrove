import 'server-only'
import { currentDatabaseClient, withStorageTransaction } from './db/client'
import { usesPostgres } from './storage-mode'
import type { User } from './types'
import type { FamilyContext, FamilyRole } from './family-types'
export type { FamilyContext } from './family-types'

export async function getFamiliesEnabled(): Promise<boolean> {
  if (!usesPostgres()) return false
  return withStorageTransaction(async () => {
    const client = currentDatabaseClient()!
    if (!(await client.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0].name) return false
    return (await client.query('SELECT enabled FROM habittrove.family_configuration WHERE singleton')).rows[0]?.enabled === true
  }, { readOnly: true })
}

// Callers obtain the actor from the verified session, never from action arguments.
export async function withFreshFamilyActor<T>(actor: User, operation: (isSiteAdmin: boolean) => Promise<T>, options: { readOnly?: boolean } = {}): Promise<T> {
  if (!usesPostgres()) throw new Error('Families require PostgreSQL')
  return withStorageTransaction(async () => {
    const client = currentDatabaseClient()!
    const user = (await client.query('SELECT id,is_admin,auth_version FROM habittrove.users WHERE id=$1', [actor.id])).rows[0]
    if (!user || (actor.authVersion !== undefined && (user.auth_version ?? 0) !== actor.authVersion)) throw new Error('Unauthorized')
    const keys = ['actor_id', 'site_admin', 'family_id', 'family_role', 'scope_validated']
    const prior = await client.query(`SELECT ${keys.map((key) => `current_setting('habittrove.${key}',true) AS ${key}`).join(',')}`)
    await client.query("SELECT set_config('habittrove.actor_id',$1,true),set_config('habittrove.site_admin',$2,true),set_config('habittrove.family_id','',true),set_config('habittrove.family_role','',true),set_config('habittrove.scope_validated','',true)", [actor.id, user.is_admin === true ? 'true' : 'false'])
    try { return await operation(user.is_admin === true) }
    finally {
      // Restore nested scopes; outer transaction completion also clears every local setting.
      await client.query(`SELECT ${keys.map((key, index) => `set_config('habittrove.${key}',$${index + 1},true)`).join(',')}`, keys.map((key) => prior.rows[0][key] ?? '')).catch(() => undefined)
    }
  }, options)
}

async function resolveCurrentContext(actor: User, isSiteAdmin: boolean, requestedFamilyId?: string): Promise<FamilyContext | undefined> {
  const client = currentDatabaseClient()!
  if (!await getFamiliesEnabled()) return undefined
  let familyId = requestedFamilyId
  if (familyId === undefined) {
    const first = await client.query(`SELECT f.id FROM habittrove.families f
      LEFT JOIN habittrove.family_memberships m ON m.family_id=f.id AND m.user_id=$1 AND m.active
      WHERE $2::boolean OR m.user_id IS NOT NULL ORDER BY f.name,f.id LIMIT 1`, [actor.id, isSiteAdmin])
    familyId = first.rows[0]?.id
    if (familyId === undefined) return undefined
  }
  if (typeof familyId !== 'string' || familyId.length > 128) throw new Error('Invalid family')
  const membership = (await client.query('SELECT role FROM habittrove.family_memberships WHERE family_id=$1 AND user_id=$2 AND active', [familyId, actor.id])).rows[0]
  if (!membership && !isSiteAdmin) throw new Error('Family access denied')
  const family = (await client.query('SELECT id FROM habittrove.families WHERE id=$1', [familyId])).rows[0]
  if (!family) throw new Error('Family access denied')
  const role: FamilyRole | 'site-admin' = isSiteAdmin ? 'site-admin' : membership.role
  await client.query("SELECT set_config('habittrove.family_id',$1,true),set_config('habittrove.family_role',$2,true),set_config('habittrove.scope_validated','true',true)", [familyId, role])
  const members = await client.query('SELECT user_id FROM habittrove.family_memberships WHERE family_id=$1 AND active ORDER BY user_id', [familyId])
  const managed = await client.query('SELECT member_id FROM habittrove.family_manager_assignments WHERE family_id=$1 AND manager_id=$2 ORDER BY member_id', [familyId, actor.id])
  return { familyId, actorId: actor.id, isSiteAdmin, role, memberIds: members.rows.map((row) => row.user_id), managedUserIds: managed.rows.map((row) => row.member_id) }
}

export async function resolveFamilyContext(actor: User, requestedFamilyId?: string, options: { readOnly?: boolean } = {}): Promise<FamilyContext | undefined> {
  return withFreshFamilyActor(actor, (siteAdmin) => resolveCurrentContext(actor, siteAdmin, requestedFamilyId), options)
}
export async function withFamilyScope<T>(actor: User, operation: (context: FamilyContext | undefined) => Promise<T>, requestedFamilyId?: string, options: { readOnly?: boolean } = {}): Promise<T> {
  return withFreshFamilyActor(actor, async (siteAdmin) => operation(await resolveCurrentContext(actor, siteAdmin, requestedFamilyId)), options)
}
