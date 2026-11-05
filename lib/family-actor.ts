import 'server-only'
import { currentDatabaseClient } from './db/client'
import { readAuthDocument } from './db/repository'
import { getFamiliesEnabled } from './family-scope'
import { usesPostgres } from './storage-mode'
import { validateSettings } from './security-validation'
import type { FamilyContext } from './family-types'
import type { PersonalFolder, Settings, StatusDay, User, UserData } from './types'

export type FamilyPreferences = { folders: PersonalFolder[]; statusDays: StatusDay[]; lastNotificationReadTimestamp?: string }
const query = (text: string, values: unknown[] = []) => {
  const client = currentDatabaseClient()
  if (!client) throw new Error('An established family transaction is required')
  return client.query(text, values)
}
async function currentIdentity(actor: User) {
  const state = (await query("SELECT current_setting('habittrove.actor_id',true) AS actor_id,current_setting('habittrove.site_admin',true) AS site_admin,current_setting('habittrove.family_id',true) AS family_id,current_setting('habittrove.scope_validated',true) AS validated")).rows[0]
  const user = (await query('SELECT id,is_admin,auth_version,attributes FROM habittrove.users WHERE id=$1', [actor.id])).rows[0]
  if (state.actor_id !== actor.id || !user || (actor.authVersion !== undefined && (user.auth_version ?? 0) !== actor.authVersion)) throw new Error('Fresh identity context required')
  if ((user.is_admin === true) !== (state.site_admin === 'true')) throw new Error('Identity authority changed')
  return { state, user }
}
export async function requireCurrentFamilyContext(actor: User): Promise<FamilyContext> {
  const { state, user } = await currentIdentity(actor)
  if (state.validated !== 'true' || !state.family_id) throw new Error('Selected family context required')
  const membership = (await query('SELECT role FROM habittrove.family_memberships WHERE family_id=$1 AND user_id=$2 AND active', [state.family_id, actor.id])).rows[0]
  if (!membership && !user.is_admin) throw new Error('Family access denied')
  const members = (await query('SELECT user_id FROM habittrove.family_memberships WHERE family_id=$1 AND active ORDER BY user_id', [state.family_id])).rows
  const managed = (await query("SELECT a.member_id FROM habittrove.family_manager_assignments a JOIN habittrove.family_memberships m ON m.family_id=a.family_id AND m.user_id=a.member_id AND m.active JOIN habittrove.family_memberships manager ON manager.family_id=a.family_id AND manager.user_id=a.manager_id AND manager.active AND manager.role IN ('owner','manager') WHERE a.family_id=$1 AND a.manager_id=$2 ORDER BY a.member_id", [state.family_id, actor.id])).rows
  return { familyId: state.family_id, actorId: actor.id, isSiteAdmin: user.is_admin === true, role: user.is_admin ? 'site-admin' : membership.role, memberIds: members.map((row) => row.user_id), managedUserIds: managed.map((row) => row.member_id) }
}
export async function readFamilyPreferences(actor: User): Promise<FamilyPreferences> {
  const context = await requireCurrentFamilyContext(actor)
  const value = (await query('SELECT preferences FROM habittrove.family_preferences WHERE family_id=$1 AND user_id=$2', [context.familyId, actor.id])).rows[0]?.preferences ?? {}
  return { folders: value.folders ?? [], statusDays: value.statusDays ?? [], ...(value.lastNotificationReadTimestamp ? { lastNotificationReadTimestamp: value.lastNotificationReadTimestamp } : {}) }
}
export async function saveFamilyPreferences(actor: User, patch: Partial<FamilyPreferences>): Promise<FamilyPreferences> {
  const context = await requireCurrentFamilyContext(actor)
  if (!context.memberIds.includes(actor.id)) throw new Error('Active family membership required for personal preferences')
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some((key) => !['folders', 'statusDays', 'lastNotificationReadTimestamp'].includes(key))) throw new Error('Invalid family preferences')
  if (patch.folders !== undefined && (!Array.isArray(patch.folders) || patch.folders.length > 50 || patch.folders.some((folder) => !folder || typeof folder.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(folder.id) || typeof folder.name !== 'string' || !folder.name.trim() || folder.name.length > 80 || !Array.isArray(folder.itemIds) || folder.itemIds.length > 2000 || folder.itemIds.some((id) => typeof id !== 'string' || !id || id.length > 200)))) throw new Error('Invalid folders')
  if (patch.statusDays !== undefined && (!Array.isArray(patch.statusDays) || patch.statusDays.length > 90 || patch.statusDays.some((day) => !day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(Date.parse(day.date)) || !['sick', 'travel', 'rest', 'other'].includes(day.status)))) throw new Error('Invalid status dates')
  if (patch.lastNotificationReadTimestamp !== undefined && (typeof patch.lastNotificationReadTimestamp !== 'string' || !Number.isFinite(Date.parse(patch.lastNotificationReadTimestamp)))) throw new Error('Invalid notification timestamp')
  await query('INSERT INTO habittrove.family_preferences(family_id,user_id,preferences) VALUES($1,$2,$3) ON CONFLICT(family_id,user_id) DO UPDATE SET preferences=family_preferences.preferences || EXCLUDED.preferences', [context.familyId, actor.id, JSON.stringify(patch)])
  return readFamilyPreferences(actor)
}
export async function getFamilyScopedUser(actor: User): Promise<User> {
  if (!usesPostgres() || !await getFamiliesEnabled()) return actor
  const context = await requireCurrentFamilyContext(actor)
  const fresh = (await readAuthDocument())?.users.find((user) => user.id === actor.id)
  if (!fresh) throw new Error('Unauthorized')
  const { permissions: _permissions, managedUserIds: _managed, personalFolders: _folders, statusDays: _status, lastNotificationReadTimestamp: _read, ...identity } = fresh
  const resources = (await query('SELECT resource,can_write,can_interact FROM habittrove.family_permissions WHERE family_id=$1 AND user_id=$2', [context.familyId, actor.id])).rows
  const permissions = { habit: { write: false, interact: false }, wishlist: { write: false, interact: false }, coins: { write: false, interact: false } }
  for (const row of resources) if (row.resource === 'habit' || row.resource === 'wishlist' || row.resource === 'coins') permissions[row.resource as keyof typeof permissions] = { write: row.can_write === true, interact: row.can_interact === true }
  const preferences = await readFamilyPreferences(actor)
  return { ...identity, permissions: [permissions], managedUserIds: context.managedUserIds, personalFolders: preferences.folders, statusDays: preferences.statusDays, ...(preferences.lastNotificationReadTimestamp ? { lastNotificationReadTimestamp: preferences.lastNotificationReadTimestamp } : {}) }
}
export async function readFamilyDirectory(actor: User): Promise<UserData> {
  const context = await requireCurrentFamilyContext(actor)
  const users = (await query('SELECT u.*,o.subject,o.issuer FROM habittrove.users u JOIN habittrove.family_memberships m ON m.user_id=u.id AND m.family_id=$1 AND m.active LEFT JOIN habittrove.oidc_identities o ON o.user_id=u.id ORDER BY u.ordinal,u.id', [context.familyId])).rows
  const permissions = (await query('SELECT user_id,resource,can_write,can_interact FROM habittrove.family_permissions WHERE family_id=$1', [context.familyId])).rows
  const assignments = (await query("SELECT a.manager_id,a.member_id FROM habittrove.family_manager_assignments a JOIN habittrove.family_memberships manager ON manager.family_id=a.family_id AND manager.user_id=a.manager_id AND manager.active AND manager.role IN ('owner','manager') JOIN habittrove.family_memberships member ON member.family_id=a.family_id AND member.user_id=a.member_id AND member.active WHERE a.family_id=$1", [context.familyId])).rows
  const preferences = new Map((await query('SELECT user_id,preferences FROM habittrove.family_preferences WHERE family_id=$1', [context.familyId])).rows.map((row) => [row.user_id, row.preferences]))
  return { users: users.map((row): User => {
    const { permissions: _permissions, managedUserIds: _managed, personalFolders: _folders, statusDays: _status, lastNotificationReadTimestamp: _read, personalSettings, ...identity } = row.attributes?.fields ?? {}
    const resources = { habit: { write: false, interact: false }, wishlist: { write: false, interact: false }, coins: { write: false, interact: false } }
    for (const permission of permissions.filter((permission) => permission.user_id === row.id)) if (permission.resource === 'habit' || permission.resource === 'wishlist' || permission.resource === 'coins') resources[permission.resource as keyof typeof resources] = { write: permission.can_write === true, interact: permission.can_interact === true }
    const personal = preferences.get(row.id) ?? {}
    return { ...identity, id: row.id, username: row.username, isAdmin: row.is_admin === true,
      ...(row.email ? { email: row.email } : {}), ...(row.password_hash ? { password: row.password_hash } : {}),
      ...(row.auth_version !== null ? { authVersion: row.auth_version } : {}),
      ...(row.subject ? { oidcSubject: row.subject } : {}), ...(row.issuer ? { oidcIssuer: row.issuer } : {}),
      permissions: [resources], managedUserIds: assignments.filter((assignment) => assignment.manager_id === row.id).map((assignment) => assignment.member_id),
      personalFolders: personal.folders ?? [], statusDays: personal.statusDays ?? [],
      ...(personal.lastNotificationReadTimestamp ? { lastNotificationReadTimestamp: personal.lastNotificationReadTimestamp } : {}),
      ...(row.id === actor.id && personalSettings ? { personalSettings } : {}),
    }
  }) }
}
export async function readFamilySettings(actor: User, base: Settings): Promise<Settings> {
  const context = await requireCurrentFamilyContext(actor)
  const { user } = await currentIdentity(actor)
  const family = (await query('SELECT settings FROM habittrove.family_settings WHERE family_id=$1', [context.familyId])).rows[0]?.settings ?? {}
  const personal = user.attributes?.fields?.personalSettings ?? {}
  return validateSettings({ ...base, ui: { ...base.ui, ...personal.ui }, system: { ...base.system, ...(family.timezone ? { timezone: family.timezone } : {}), ...(family.weekStartDay !== undefined ? { weekStartDay: family.weekStartDay } : {}), ...(personal.language ? { language: personal.language } : {}) } })
}
export async function saveFamilySettings(actor: User, settings: Settings, base: Settings): Promise<void> {
  const context = await requireCurrentFamilyContext(actor)
  const valid = validateSettings(settings)
  const current = await readFamilySettings(actor, base)
  if (valid.system.autoBackupEnabled !== base.system.autoBackupEnabled || JSON.stringify(valid.profile) !== JSON.stringify(base.profile)) throw new Error('Instance settings require the global administrator path')
  const familyChanged = valid.system.timezone !== current.system.timezone || valid.system.weekStartDay !== current.system.weekStartDay
  if (familyChanged && !context.isSiteAdmin && context.role !== 'owner') throw new Error('Family owner access required for shared calendar settings')
  if (familyChanged) await query('INSERT INTO habittrove.family_settings(family_id,settings) VALUES($1,$2) ON CONFLICT(family_id) DO UPDATE SET settings=EXCLUDED.settings', [context.familyId, JSON.stringify({ timezone: valid.system.timezone, weekStartDay: valid.system.weekStartDay })])
  await savePersonalSettings(actor, valid)
}
export async function savePersonalSettings(actor: User, settings: Settings, current?: Settings): Promise<void> {
  await currentIdentity(actor)
  const valid = validateSettings(settings)
  if (current && (valid.system.timezone !== current.system.timezone ||
      valid.system.weekStartDay !== current.system.weekStartDay ||
      valid.system.autoBackupEnabled !== current.system.autoBackupEnabled ||
      JSON.stringify(valid.profile) !== JSON.stringify(current.profile))) {
    throw new Error('Choose a family before changing shared settings')
  }
  await query("UPDATE habittrove.users SET attributes=jsonb_set(attributes,'{fields}',COALESCE(attributes->'fields','{}') || jsonb_build_object('personalSettings',$2::jsonb)) WHERE id=$1", [actor.id, JSON.stringify({ ui: valid.ui, language: valid.system.language })])
}
export async function readCurrentGlobalWalletBalance(actor: User, userId = actor.id): Promise<number> {
  const { user } = await currentIdentity(actor)
  if (typeof userId !== 'string' || !userId || userId.length > 128) throw new Error('Invalid wallet owner')
  if (userId !== actor.id && !user.is_admin) {
    const context = await requireCurrentFamilyContext(actor)
    if (!context.managedUserIds.includes(userId)) throw new Error('Wallet access denied')
  }
  return Number((await query('SELECT balance FROM habittrove.global_wallet_totals WHERE user_id=$1', [userId])).rows[0]?.balance ?? 0)
}
