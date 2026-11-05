import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { currentDatabaseClient, withStorageTransaction } from './db/client'
import { getFamiliesEnabled, withFamilyScope, withFreshFamilyActor } from './family-scope'
import { getDefaultSettings, type User } from './types'
import type { FamilyContext, FamilyMemberInfo, FamilyRemovalImpact, FamilyRole, FamilyState, FamilySummary, HouseholdInviteInfo, LegacyFamilyMapping, LegacyFamilyMappingPreview, PublicHouseholdInvite } from './family-types'

const query = (text: string, values: unknown[] = []) => {
  const client = currentDatabaseClient()
  if (!client) throw new Error('Family operation requires a transaction')
  return client.query(text, values)
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function checkedId(id: string): string {
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('Invalid identifier')
  return id
}
function checkedName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\u0000-\u001f]/.test(name)) throw new Error('Family name must contain 1–100 characters')
  return name.trim()
}
function checkedRole(role: unknown): FamilyRole {
  if (role !== 'owner' && role !== 'manager' && role !== 'member') throw new Error('Invalid family role')
  return role
}
async function audit(actorId: string, familyId: string, action: string, targetId?: string): Promise<void> {
  await query('INSERT INTO habittrove.family_audit(id,family_id,actor_id,action,target_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), familyId, actorId, action, targetId ?? null])
  await query('UPDATE habittrove.families SET revision=revision+1 WHERE id=$1', [familyId])
}
async function ownerOperation<T>(actor: User, familyId: string, operation: (context: FamilyContext) => Promise<T>): Promise<T> {
  checkedId(familyId)
  return withFreshFamilyActor(actor, async (siteAdmin) => {
    const membership = (await query('SELECT role FROM habittrove.family_memberships WHERE family_id=$1 AND user_id=$2 AND active', [familyId, actor.id])).rows[0]
    if (!siteAdmin && membership?.role !== 'owner') throw new Error('Family owner access required')
    if (!(await query('SELECT id FROM habittrove.families WHERE id=$1 FOR UPDATE', [familyId])).rowCount) throw new Error('Family not found')
    await query("SELECT set_config('habittrove.family_id',$1,true),set_config('habittrove.family_role',$2,true),set_config('habittrove.scope_validated','true',true)", [familyId, siteAdmin ? 'site-admin' : 'owner'])
    const members = (await query('SELECT user_id FROM habittrove.family_memberships WHERE family_id=$1 AND active', [familyId])).rows.map((row) => row.user_id)
    return operation({ familyId, actorId: actor.id, isSiteAdmin: siteAdmin, role: siteAdmin ? 'site-admin' : 'owner', memberIds: members, managedUserIds: [] })
  })
}
async function initializeMembershipPermissions(familyId: string, userId: string): Promise<void> {
  // Match the established invitation defaults; rejoining keeps previous per-family choices.
  for (const resource of ['habit', 'wishlist', 'coins']) await query('INSERT INTO habittrove.family_permissions(family_id,user_id,resource,can_write,can_interact) VALUES($1,$2,$3,true,true) ON CONFLICT DO NOTHING', [familyId, userId, resource])
}
async function initializeFamilyDocuments(familyId: string, adoptLegacy = false): Promise<void> {
  for (const kind of ['habits', 'wishlist']) {
    const metadata = adoptLegacy ? (await query("SELECT jsonb_set(metadata,'{fields}',COALESCE(metadata->'fields','{}')-'familyId') AS value FROM habittrove.documents WHERE kind=$1", [kind])).rows[0]?.value : undefined
    await query('INSERT INTO habittrove.family_document_revisions(family_id,kind,metadata) VALUES($1,$2,$3) ON CONFLICT(family_id,kind) DO NOTHING', [familyId, kind, JSON.stringify(metadata ?? { fields: {}, present: [] })])
    if (metadata) await query("UPDATE habittrove.family_document_revisions SET metadata=$3 WHERE family_id=$1 AND kind=$2 AND revision=1 AND metadata='{\"fields\":{},\"present\":[]}'::jsonb", [familyId, kind, JSON.stringify(metadata)])
  }
}
async function requireMember(familyId: string, userId: string): Promise<{ role: FamilyRole }> {
  const row = (await query('SELECT role FROM habittrove.family_memberships WHERE family_id=$1 AND user_id=$2 AND active', [familyId, checkedId(userId)])).rows[0]
  if (!row) throw new Error('Active family member required')
  return row
}

export async function readFamilyState(actor: User, selectedFamilyId?: string): Promise<FamilyState> {
  if (!await getFamiliesEnabled()) return { families: [], members: [], familiesEnabled: false }
  return withFreshFamilyActor(actor, async (siteAdmin) => {
    const rows = await query(`SELECT f.id,f.name,m.role,
      (SELECT count(*) FROM habittrove.family_memberships n WHERE n.family_id=f.id AND n.active) AS member_count
      FROM habittrove.families f LEFT JOIN habittrove.family_memberships m ON m.family_id=f.id AND m.user_id=$1 AND m.active
      WHERE $2::boolean OR m.user_id IS NOT NULL ORDER BY f.name,f.id`, [actor.id, siteAdmin])
    const families: FamilySummary[] = rows.rows.map((row) => ({ id: row.id, name: row.name, role: siteAdmin ? 'site-admin' : row.role, memberCount: Number(row.member_count) }))
    // Each count uses a separately validated membership, so a dual-family user's
    // selector is accurate without exposing an unselected family's member directory.
    for (const family of families) family.memberCount = await withFamilyScope(actor, async () => Number((await query('SELECT count(*) AS n FROM habittrove.family_memberships WHERE family_id=$1 AND active', [family.id])).rows[0].n), family.id)
    const familyId = selectedFamilyId === undefined ? families[0]?.id : families.some((family) => family.id === selectedFamilyId) ? selectedFamilyId : undefined
    if (!familyId) return { families, members: [], familiesEnabled: true }
    return withFamilyScope(actor, async (context) => {
      if (!context) throw new Error('Family context required')
      const members: FamilyMemberInfo[] = (await query(`SELECT m.user_id,u.username,m.role,m.active,
        COALESCE((SELECT array_agg(a.member_id ORDER BY a.member_id) FROM habittrove.family_manager_assignments a WHERE a.family_id=m.family_id AND a.manager_id=m.user_id),ARRAY[]::text[]) AS managed
        FROM habittrove.family_memberships m JOIN habittrove.users u ON u.id=m.user_id WHERE m.family_id=$1 ORDER BY u.username,m.user_id`, [familyId])).rows.map((row) => ({ id: row.user_id, username: row.username, role: row.role, active: row.active, managedUserIds: row.managed }))
      // Count inside the validated family scope, where all its memberships are visible.
      const selected = families.find((family) => family.id === familyId)!
      selected.memberCount = members.filter((member) => member.active).length
      return { families, selectedFamilyId: familyId, members, familiesEnabled: true }
    }, familyId)
  })
}

export async function provisionFamily(actor: User, name: string, ownerId = actor.id): Promise<FamilySummary> {
  return withFreshFamilyActor(actor, async (siteAdmin) => {
    if (!siteAdmin) throw new Error('Site administrator access required')
    const familyId = randomUUID()
    if (!(await query('SELECT id FROM habittrove.users WHERE id=$1', [checkedId(ownerId)])).rowCount) throw new Error('Owner account not found')
    const familyName = checkedName(name)
    await query('INSERT INTO habittrove.families(id,name) VALUES($1,$2)', [familyId, familyName])
    await query("SELECT set_config('habittrove.family_id',$1,true),set_config('habittrove.family_role','site-admin',true),set_config('habittrove.scope_validated','true',true)", [familyId])
    await query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [familyId, ownerId])
    await initializeMembershipPermissions(familyId, ownerId)
    await initializeFamilyDocuments(familyId)
    const defaults = getDefaultSettings().system
    await query('INSERT INTO habittrove.family_settings(family_id,settings) VALUES($1,$2)', [familyId, JSON.stringify({ timezone: defaults.timezone, weekStartDay: defaults.weekStartDay })])
    await audit(actor.id, familyId, 'family-created', ownerId)
    return { id: familyId, name: familyName, role: 'site-admin', memberCount: 1 }
  })
}
export async function renameStoredFamily(actor: User, familyId: string, name: string): Promise<void> {
  return ownerOperation(actor, familyId, async () => {
    await query('UPDATE habittrove.families SET name=$2 WHERE id=$1', [familyId, checkedName(name)])
    await audit(actor.id, familyId, 'family-renamed')
  })
}
export async function updateStoredMembership(actor: User, familyId: string, userId: string, changes: { role?: FamilyRole; managedUserIds?: string[] }): Promise<void> {
  return ownerOperation(actor, familyId, async () => {
    const member = await requireMember(familyId, userId)
    const role = changes.role === undefined ? member.role : checkedRole(changes.role)
    if (changes.managedUserIds !== undefined && (!Array.isArray(changes.managedUserIds) || changes.managedUserIds.length > 1000)) throw new Error('Invalid manager assignments')
    const managed = changes.managedUserIds === undefined ? undefined : [...new Set(changes.managedUserIds.map(checkedId))]
    if (managed?.length && role === 'member') throw new Error('Only a manager or owner can manage members')
    if (managed?.includes(userId)) throw new Error('Self delegation is unnecessary')
    for (const id of managed ?? []) await requireMember(familyId, id)
    await query('UPDATE habittrove.family_memberships SET role=$3 WHERE family_id=$1 AND user_id=$2', [familyId, userId, role])
    if (managed !== undefined || role === 'member') {
      await query('DELETE FROM habittrove.family_manager_assignments WHERE family_id=$1 AND manager_id=$2', [familyId, userId])
      for (const id of role === 'member' ? [] : managed ?? []) await query('INSERT INTO habittrove.family_manager_assignments(family_id,manager_id,member_id) VALUES($1,$2,$3)', [familyId, userId, id])
    }
    await audit(actor.id, familyId, 'membership-updated', userId)
  })
}

async function removalImpact(familyId: string, userId: string): Promise<FamilyRemovalImpact> {
  const member = await requireMember(familyId, userId)
  if (member.role === 'owner' && Number((await query("SELECT count(*) AS count FROM habittrove.family_memberships WHERE family_id=$1 AND role='owner' AND active", [familyId])).rows[0].count) <= 1) throw new Error('The last active family owner must remain')
  const habits = (await query(`SELECT h.id,h.revision FROM habittrove.habits h WHERE h.family_id=$1 AND EXISTS(SELECT 1 FROM habittrove.habit_assignees a WHERE a.family_id=$1 AND a.habit_id=h.id AND a.user_id=$2)
    AND NOT EXISTS(SELECT 1 FROM habittrove.habit_assignees a JOIN habittrove.family_memberships m ON m.family_id=a.family_id AND m.user_id=a.user_id AND m.active WHERE a.family_id=$1 AND a.habit_id=h.id AND a.user_id<>$2) ORDER BY h.id`, [familyId, userId])).rows
  const rewards = (await query(`SELECT w.id,w.revision FROM habittrove.wishlist_items w WHERE w.family_id=$1 AND EXISTS(SELECT 1 FROM habittrove.wishlist_assignees a WHERE a.family_id=$1 AND a.item_id=w.id AND a.user_id=$2)
    AND NOT EXISTS(SELECT 1 FROM habittrove.wishlist_assignees a JOIN habittrove.family_memberships m ON m.family_id=a.family_id AND m.user_id=a.user_id AND m.active WHERE a.family_id=$1 AND a.item_id=w.id AND a.user_id<>$2) ORDER BY w.id`, [familyId, userId])).rows
  const pending = (await query("SELECT habit_id,ordinal,id FROM habittrove.completions WHERE family_id=$1 AND COALESCE(beneficiary_id,actor_id)=$2 AND approval='pending' AND NOT COALESCE(voided,false) ORDER BY habit_id,ordinal", [familyId, userId])).rows
  const approvers = (await query(`SELECT a.habit_id FROM habittrove.habit_approvers a WHERE a.family_id=$1 AND a.user_id=$2 AND NOT EXISTS(SELECT 1 FROM habittrove.habit_approvers b JOIN habittrove.family_memberships m ON m.family_id=b.family_id AND m.user_id=b.user_id AND m.active WHERE b.family_id=$1 AND b.habit_id=a.habit_id AND b.user_id<>$2) ORDER BY a.habit_id`, [familyId, userId])).rows
  const delegations = (await query('SELECT manager_id,member_id FROM habittrove.family_manager_assignments WHERE family_id=$1 AND (manager_id=$2 OR member_id=$2) ORDER BY manager_id,member_id', [familyId, userId])).rows
  const revision = (await query('SELECT revision FROM habittrove.families WHERE id=$1', [familyId])).rows[0].revision
  return { familyId, userId, revision: digest({ revision, habits, rewards, pending, approvers, delegations }), archivedItemIds: [...habits, ...rewards].map((row) => row.id), archivedHabitIds: habits.map((row) => row.id), archivedRewardIds: rewards.map((row) => row.id), withdrawnSubmissionIds: pending.map((row) => row.id ?? `${row.habit_id}:${row.ordinal}`), reassignedApproverItemIds: approvers.map((row) => row.habit_id), removedDelegations: delegations.length, walletRetained: true, historyRetained: true }
}
export async function previewStoredRemoval(actor: User, familyId: string, userId: string): Promise<FamilyRemovalImpact> {
  return ownerOperation(actor, familyId, () => removalImpact(familyId, checkedId(userId)))
}
export async function removeStoredMember(actor: User, familyId: string, userId: string, expectedRevision?: string): Promise<void> {
  return ownerOperation(actor, familyId, async () => {
    const impact = await removalImpact(familyId, checkedId(userId))
    if (!expectedRevision || expectedRevision !== impact.revision) throw new Error('Membership impact changed; preview removal again')
    await query('DELETE FROM habittrove.family_manager_assignments WHERE family_id=$1 AND (manager_id=$2 OR member_id=$2)', [familyId, userId])
    await query('DELETE FROM habittrove.habit_assignees WHERE family_id=$1 AND user_id=$2', [familyId, userId])
    await query('DELETE FROM habittrove.wishlist_assignees WHERE family_id=$1 AND user_id=$2', [familyId, userId])
    await query('DELETE FROM habittrove.habit_approvers WHERE family_id=$1 AND user_id=$2', [familyId, userId])
    for (const habitId of impact.reassignedApproverItemIds) {
      const replacement = (await query(`SELECT m.user_id FROM habittrove.family_memberships m JOIN habittrove.habits h ON h.family_id=m.family_id WHERE m.family_id=$1 AND m.active AND m.user_id<>$2 AND h.id=$3 AND (m.user_id=h.created_by OR m.role='owner') ORDER BY (m.user_id=h.created_by) DESC,m.user_id LIMIT 1`, [familyId, userId, habitId])).rows[0]
      if (!replacement) throw new Error('An active replacement approver is required')
      await query('INSERT INTO habittrove.habit_approvers(habit_id,ordinal,user_id,family_id) SELECT $1,COALESCE(max(ordinal)+1,0),$2,$3 FROM habittrove.habit_approvers WHERE habit_id=$1', [habitId, replacement.user_id, familyId])
      await query("UPDATE habittrove.completions SET needs_review=true,attributes=jsonb_set(COALESCE(attributes,'{}'),'{fields}',COALESCE(attributes->'fields','{}') || '{\"needsReview\":true}'::jsonb) WHERE family_id=$1 AND habit_id=$2 AND approval='pending'", [familyId, habitId])
    }
    await query("UPDATE habittrove.habits SET archived=true,attributes=jsonb_set(attributes,'{present}',COALESCE(attributes->'present','[]') || '[\"archived\"]'::jsonb),revision=revision+1 WHERE family_id=$1 AND id=ANY($2::text[])", [familyId, impact.archivedHabitIds])
    await query("UPDATE habittrove.wishlist_items SET attributes=jsonb_set(attributes,'{fields}',COALESCE(attributes->'fields','{}') || '{\"archived\":true}'::jsonb),revision=revision+1 WHERE family_id=$1 AND id=ANY($2::text[])", [familyId, impact.archivedRewardIds])
    // PostgreSQL checks SELECT policy on the updated row too. Permit this narrow
    // metadata transition inside the owner transaction, then immediately hide withdrawn evidence.
    const priorEvidenceMaintenance = (await query("SELECT current_setting('habittrove.evidence_maintenance',true) AS value")).rows[0].value
    await query("SELECT set_config('habittrove.evidence_maintenance','true',true)")
    try {
      await query("UPDATE habittrove.attachments a SET inaccessible=true WHERE a.family_id=$1 AND EXISTS(SELECT 1 FROM habittrove.completions c WHERE c.family_id=a.family_id AND c.habit_id=a.habit_id AND c.id=a.completion_id AND COALESCE(c.beneficiary_id,c.actor_id)=$2 AND c.approval='pending' AND NOT COALESCE(c.voided,false))", [familyId, userId])
    } finally { await query("SELECT set_config('habittrove.evidence_maintenance',$1,true)", [priorEvidenceMaintenance ?? '']).catch(() => undefined) }
    await query("UPDATE habittrove.completions SET approval='rejected',voided=true,needs_review=true,attributes=jsonb_set(jsonb_set(COALESCE(attributes,'{}'),'{present}',COALESCE(attributes->'present','[]') || '[\"voided\",\"approval\"]'::jsonb),'{fields}',COALESCE(attributes->'fields','{}') || '{\"needsReview\":true}'::jsonb) WHERE family_id=$1 AND COALESCE(beneficiary_id,actor_id)=$2 AND approval='pending' AND NOT COALESCE(voided,false)", [familyId, userId])
    await query('UPDATE habittrove.family_memberships SET active=false,removed_at=now() WHERE family_id=$1 AND user_id=$2', [familyId, userId])
    await query("UPDATE habittrove.family_document_revisions SET revision=revision+1 WHERE family_id=$1 AND kind IN ('habits','wishlist')", [familyId])
    await audit(actor.id, familyId, 'membership-removed', userId)
  })
}

export async function issueHouseholdInvite(actor: User, familyId: string, email: string, role: 'member' | 'manager', managedBy?: string): Promise<{ token: string }> {
  return ownerOperation(actor, familyId, async () => {
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('A valid email is required')
    if (role !== 'member' && role !== 'manager') throw new Error('Invalid invitation role')
    if (managedBy && (await requireMember(familyId, managedBy)).role === 'member') throw new Error('A family manager is required')
    const token = randomBytes(32).toString('base64url')
    await query('INSERT INTO habittrove.household_invitations(token_hash,family_id,email,role,created_by,managed_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [digest(token), familyId, email.trim().toLowerCase(), role, actor.id, managedBy ?? null, new Date(Date.now() + 7 * 86400000)])
    await audit(actor.id, familyId, 'invitation-created')
    return { token }
  })
}
export async function readHouseholdInvites(actor: User, familyId: string): Promise<HouseholdInviteInfo[]> {
  return ownerOperation(actor, familyId, async () => (await query('SELECT token_hash,email,role,managed_by,expires_at,created_by,consumed_at,revoked_at FROM habittrove.household_invitations WHERE family_id=$1 ORDER BY expires_at DESC', [familyId])).rows.map((row) => ({ tokenHash: row.token_hash, email: row.email, role: row.role, ...(row.managed_by ? { managedBy: row.managed_by } : {}), expiresAt: new Date(row.expires_at).toISOString(), createdBy: row.created_by, consumed: !!row.consumed_at, revoked: !!row.revoked_at })))
}
export async function revokeStoredInvite(actor: User, familyId: string, tokenHash: string): Promise<void> {
  return ownerOperation(actor, familyId, async () => {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('Invalid invitation')
    if (!(await query('UPDATE habittrove.household_invitations SET revoked_at=now() WHERE family_id=$1 AND token_hash=$2 AND consumed_at IS NULL AND revoked_at IS NULL', [familyId, tokenHash])).rowCount) throw new Error('Invitation is unavailable')
    await audit(actor.id, familyId, 'invitation-revoked')
  })
}
function inviteHash(token: string): string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invitation is unavailable')
  return digest(token)
}
async function withInviteToken<T>(token: string, operation: (hash: string) => Promise<T>, options: { readOnly?: boolean } = {}): Promise<T> {
  const hash = inviteHash(token)
  return withStorageTransaction(async () => {
    const prior = (await query("SELECT current_setting('habittrove.invite_token_hash',true) AS value")).rows[0].value
    await query("SELECT set_config('habittrove.invite_token_hash',$1,true)", [hash])
    try { return await operation(hash) }
    finally { await query("SELECT set_config('habittrove.invite_token_hash',$1,true)", [prior ?? '']).catch(() => undefined) }
  }, options)
}
export async function readPublicHouseholdInvite(token: string): Promise<PublicHouseholdInvite | undefined> {
  if (!await getFamiliesEnabled()) return undefined
  return withInviteToken(token, async (hash) => {
    const invite = (await query('SELECT f.name,i.email,i.role,i.expires_at FROM habittrove.household_invitations i JOIN habittrove.families f ON f.id=i.family_id WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()', [hash])).rows[0]
    if (!invite) return undefined
    const [local, domain] = invite.email.split('@')
    return { familyName: invite.name, maskedEmail: `${local.slice(0, 1)}***@${domain}`, role: invite.role, expiresAt: new Date(invite.expires_at).toISOString() }
  })
}

async function validatedHouseholdOffer(hash: string) {
  const invite = (await query('SELECT * FROM habittrove.household_invitations WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()', [hash])).rows[0]
  if (!invite) throw new Error('Invitation is unavailable')
  const inviter = (await query('SELECT u.is_admin,m.role,m.active FROM habittrove.users u LEFT JOIN habittrove.family_memberships m ON m.user_id=u.id AND m.family_id=$1 WHERE u.id=$2', [invite.family_id, invite.created_by])).rows[0]
  if (!inviter || !(inviter.is_admin || (inviter.active && inviter.role === 'owner')) || !['member', 'manager'].includes(invite.role)) throw new Error('Invitation is unavailable')
  if (invite.managed_by && (await requireMember(invite.family_id, invite.managed_by)).role === 'member') throw new Error('Invitation is unavailable')
  return invite
}

export async function preflightNewHouseholdInvite(token: string, username: string): Promise<string> {
  if (!await getFamiliesEnabled()) throw new Error('Families are not enabled')
  return withInviteToken(token, async hash => {
    const invite = await validatedHouseholdOffer(hash)
    if ((await query('SELECT 1 FROM habittrove.users WHERE lower(email)=$1 OR lower(username)=lower($2)', [invite.email, username])).rowCount) {
      throw new Error('Account already exists; sign in to accept this invitation')
    }
    return hash
  }, { readOnly: true })
}

// The callback is trusted server code, receives the stored email privately, and must
// create local credentials. Every check and token consumption shares its transaction.
export async function withHouseholdInviteEmail(token: string, createUser: (email: string) => Promise<User>): Promise<User> {
  if (!await getFamiliesEnabled()) throw new Error('Families are not enabled')
  return withInviteToken(token, async (hash) => {
    const invite = await validatedHouseholdOffer(hash)
    if ((await query('SELECT 1 FROM habittrove.users WHERE lower(email)=$1', [invite.email])).rowCount) throw new Error('Sign in to accept an invitation for an existing account')
    const existingIds = new Set((await query('SELECT id FROM habittrove.users')).rows.map((row) => row.id))
    const account = await createUser(invite.email)
    const created = (await query('SELECT id,email,is_admin,password_hash FROM habittrove.users WHERE id=$1', [account.id])).rows[0]
    if (existingIds.has(account.id) || !created || created.email?.trim().toLowerCase() !== invite.email || created.is_admin || !created.password_hash || (await query('SELECT 1 FROM habittrove.oidc_identities WHERE user_id=$1', [account.id])).rowCount) throw new Error('Invitation acceptance must create a new local member account')
    await acceptStoredHouseholdInvite(account, token)
    return account
  })
}

// Root's new-account flow may call this after writing the newly created identity, inside
// the SAME withStorageTransaction. A thrown failure rolls credentials and acceptance back.
export async function acceptStoredHouseholdInvite(actor: User, token: string): Promise<void> {
  if (!await getFamiliesEnabled()) throw new Error('Families are not enabled')
  return withFreshFamilyActor(actor, async () => withInviteToken(token, async (hash) => {
    // The advisory write lock serializes acceptance and all membership/authority changes.
    // Initial lookup is SELECT: UPDATE visibility is deliberately unavailable before authority validation.
    const invite = await validatedHouseholdOffer(hash)
    const recipient = (await query('SELECT email FROM habittrove.users WHERE id=$1', [actor.id])).rows[0]
    if (!recipient?.email || recipient.email.trim().toLowerCase() !== invite.email) throw new Error('Sign in with the invited email address')
    const existing = (await query('SELECT active FROM habittrove.family_memberships WHERE family_id=$1 AND user_id=$2', [invite.family_id, actor.id])).rows[0]
    if (existing?.active) throw new Error('This account already belongs to the family')
    // The checked invitation provides a narrow membership capability, not site-admin authority.
    await query("SELECT set_config('habittrove.family_id',$1,true),set_config('habittrove.family_role','owner',true),set_config('habittrove.scope_validated','true',true)", [invite.family_id])
    await query('INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(family_id,user_id) DO UPDATE SET role=EXCLUDED.role,active=true,removed_at=NULL', [invite.family_id, actor.id, invite.role])
    await initializeMembershipPermissions(invite.family_id, actor.id)
    // Rejoining never restores old manager delegations or unarchives items.
    await query('DELETE FROM habittrove.family_manager_assignments WHERE family_id=$1 AND (manager_id=$2 OR member_id=$2)', [invite.family_id, actor.id])
    if (invite.managed_by && invite.managed_by !== actor.id) await query('INSERT INTO habittrove.family_manager_assignments(family_id,manager_id,member_id) VALUES($1,$2,$3)', [invite.family_id, invite.managed_by, actor.id])
    if (!(await query('UPDATE habittrove.household_invitations SET consumed_at=now(),consumed_by=$2 WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()', [hash, actor.id])).rowCount) throw new Error('Invitation is unavailable')
    await audit(actor.id, invite.family_id, 'invitation-accepted', actor.id)
  }))
}

function normalizeMapping(mapping: LegacyFamilyMapping): LegacyFamilyMapping {
  checkedId(mapping.familyId)
  const ids = (value: string[]) => {
    if (!Array.isArray(value) || value.length > 100000) throw new Error('Invalid legacy mapping')
    const result = value.map(checkedId).sort()
    if (new Set(result).size !== result.length) throw new Error('Duplicate legacy mapping identifier')
    return result
  }
  if (!Array.isArray(mapping.managers) || mapping.managers.length > 100000) throw new Error('Invalid legacy mapping')
  return { familyId: mapping.familyId, userIds: ids(mapping.userIds), habitIds: ids(mapping.habitIds), wishlistIds: ids(mapping.wishlistIds), ledgerIds: ids(mapping.ledgerIds), managers: mapping.managers.map((link) => ({ managerId: checkedId(link.managerId), memberId: checkedId(link.memberId) })).sort((a, b) => `${a.managerId}:${a.memberId}`.localeCompare(`${b.managerId}:${b.memberId}`)) }
}
async function mappingPreview(mapping: LegacyFamilyMapping): Promise<LegacyFamilyMappingPreview> {
  const users = (await query('SELECT id,auth_version,attributes FROM habittrove.users WHERE id=ANY($1::text[]) ORDER BY id', [mapping.userIds])).rows
  const habits = (await query('SELECT * FROM habittrove.habits WHERE id=ANY($1::text[]) ORDER BY id', [mapping.habitIds])).rows
  const rewards = (await query('SELECT * FROM habittrove.wishlist_items WHERE id=ANY($1::text[]) ORDER BY id', [mapping.wishlistIds])).rows
  const transactions = (await query('SELECT * FROM habittrove.coin_ledger WHERE id=ANY($1::text[]) ORDER BY id', [mapping.ledgerIds])).rows
  if (users.length !== mapping.userIds.length || habits.length !== mapping.habitIds.length || rewards.length !== mapping.wishlistIds.length || transactions.length !== mapping.ledgerIds.length) throw new Error('Mapping references missing records')
  if ([...habits, ...rewards, ...transactions].some((row) => row.family_id !== null)) throw new Error('Mapping references previously adopted records')
  const assignees = (await query('SELECT habit_id AS item_id,user_id FROM habittrove.habit_assignees WHERE habit_id=ANY($1::text[]) UNION ALL SELECT habit_id,user_id FROM habittrove.habit_approvers WHERE habit_id=ANY($1::text[]) UNION ALL SELECT item_id,user_id FROM habittrove.wishlist_assignees WHERE item_id=ANY($2::text[]) ORDER BY item_id,user_id', [mapping.habitIds, mapping.wishlistIds])).rows
  if (assignees.some((row) => !mapping.userIds.includes(row.user_id))) throw new Error('Every assignee and approver must be explicitly mapped')
  for (const link of mapping.managers) if (!mapping.userIds.includes(link.managerId) || !mapping.userIds.includes(link.memberId) || link.memberId === link.managerId) throw new Error('Manager links require explicitly mapped members')
  // Ledger owners may be historical deleted users; explicit transaction selection is the decision.
  const related: Record<string, unknown[]> = {}
  for (const table of ['completions', 'completion_recipients', 'slips', 'checklist_entries', 'attachments']) related[table] = (await query(`SELECT to_jsonb(c) AS value FROM habittrove.${table} c WHERE habit_id=ANY($1::text[]) ORDER BY to_jsonb(c)::text`, [mapping.habitIds])).rows
  for (const table of ['permissions', 'folders', 'folder_items', 'status_days']) related[table] = (await query(`SELECT to_jsonb(c) AS value FROM habittrove.${table} c WHERE user_id=ANY($1::text[]) ORDER BY to_jsonb(c)::text`, [mapping.userIds])).rows
  const legacyManagerAssignments = (await query('SELECT manager_id,member_id FROM habittrove.manager_assignments WHERE manager_id=ANY($1::text[]) OR member_id=ANY($1::text[]) ORDER BY manager_id,member_id', [mapping.userIds])).rows.map((row) => ({ managerId: row.manager_id, memberId: row.member_id }))
  related.legacyManagerAssignments = legacyManagerAssignments
  const discardedLegacyManagerAssignments = legacyManagerAssignments.filter((link) => !mapping.managers.some((retained) => retained.managerId === link.managerId && retained.memberId === link.memberId))
  related.targetPermissions = (await query('SELECT user_id,resource,can_write,can_interact FROM habittrove.family_permissions WHERE family_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id,resource', [mapping.familyId, mapping.userIds])).rows
  related.familyRevision = (await query('SELECT revision FROM habittrove.families WHERE id=$1', [mapping.familyId])).rows
  related.documents = (await query("SELECT kind,metadata FROM habittrove.documents WHERE kind IN ('habits','wishlist') ORDER BY kind")).rows
  related.settings = (await query("SELECT value FROM habittrove.setting_sections WHERE name='system'")).rows
  return { sourceHash: digest({ mapping, users, habits, rewards, transactions, assignees, related }), users: users.length, habits: habits.length, rewards: rewards.length, transactions: transactions.length, legacyManagerAssignments, discardedLegacyManagerAssignments }
}
export async function previewLegacyFamilyAdoption(actor: User, input: LegacyFamilyMapping): Promise<LegacyFamilyMappingPreview> {
  const mapping = normalizeMapping(input)
  return ownerOperation(actor, mapping.familyId, async (context) => {
    if (!context.isSiteAdmin) throw new Error('Site administrator access required')
    return mappingPreview(mapping)
  })
}
export async function applyLegacyFamilyAdoption(actor: User, input: LegacyFamilyMapping): Promise<LegacyFamilyMappingPreview> {
  const mapping = normalizeMapping(input)
  return ownerOperation(actor, mapping.familyId, async (context) => {
    if (!context.isSiteAdmin) throw new Error('Site administrator access required')
    const preview = await mappingPreview(mapping)
    if (!input.expectedSourceHash || input.expectedSourceHash !== preview.sourceHash) throw new Error('Legacy source changed; review a fresh mapping preview')
    for (const userId of mapping.userIds) await query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT(family_id,user_id) DO UPDATE SET active=true,removed_at=NULL", [mapping.familyId, userId])
    for (const link of mapping.managers) {
      await query("UPDATE habittrove.family_memberships SET role='manager' WHERE family_id=$1 AND user_id=$2 AND role='member'", [mapping.familyId, link.managerId])
      await query('INSERT INTO habittrove.family_manager_assignments(family_id,manager_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [mapping.familyId, link.managerId, link.memberId])
    }
    await query('UPDATE habittrove.habits SET family_id=$1 WHERE id=ANY($2::text[])', [mapping.familyId, mapping.habitIds])
    await query('UPDATE habittrove.wishlist_items SET family_id=$1 WHERE id=ANY($2::text[])', [mapping.familyId, mapping.wishlistIds])
    for (const table of ['habit_assignees', 'habit_approvers', 'checklist_entries', 'completions', 'completion_recipients', 'slips']) await query(`UPDATE habittrove.${table} SET family_id=$1 WHERE habit_id=ANY($2::text[])`, [mapping.familyId, mapping.habitIds])
    await query('UPDATE habittrove.wishlist_assignees SET family_id=$1 WHERE item_id=ANY($2::text[])', [mapping.familyId, mapping.wishlistIds])
    await query('UPDATE habittrove.attachments SET family_id=$1 WHERE habit_id=ANY($2::text[])', [mapping.familyId, mapping.habitIds])
    await query('UPDATE habittrove.coin_ledger SET family_id=$1 WHERE id=ANY($2::text[])', [mapping.familyId, mapping.ledgerIds])
    // Copy only explicitly selected users' preferences; no inferred membership or ledger redistribution.
    for (const userId of mapping.userIds) {
      await query('DELETE FROM habittrove.family_permissions WHERE family_id=$1 AND user_id=$2', [mapping.familyId, userId])
      await query("INSERT INTO habittrove.family_permissions(family_id,user_id,resource,can_write,can_interact) SELECT $1,$2,resource,false,false FROM unnest(ARRAY['habit','wishlist','coins']) resource", [mapping.familyId, userId])
      await query('INSERT INTO habittrove.family_permissions(family_id,user_id,resource,can_write,can_interact) SELECT $1,user_id,resource,bool_or(can_write),bool_or(can_interact) FROM habittrove.permissions WHERE user_id=$2 GROUP BY user_id,resource ON CONFLICT(family_id,user_id,resource) DO UPDATE SET can_write=EXCLUDED.can_write,can_interact=EXCLUDED.can_interact', [mapping.familyId, userId])
      const folders = (await query('SELECT id,name,ordinal FROM habittrove.folders WHERE user_id=$1 ORDER BY ordinal', [userId])).rows
      const folderItems = (await query('SELECT folder_ordinal,item_id FROM habittrove.folder_items WHERE user_id=$1 AND item_id=ANY($2::text[]) ORDER BY folder_ordinal,ordinal', [userId, [...mapping.habitIds, ...mapping.wishlistIds]])).rows
      const statusDays = (await query("SELECT to_char(local_date,'YYYY-MM-DD') AS local_date,status FROM habittrove.status_days WHERE user_id=$1 ORDER BY ordinal", [userId])).rows
      await query('INSERT INTO habittrove.family_preferences(family_id,user_id,preferences) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [mapping.familyId, userId, JSON.stringify({ folders: folders.map((folder) => ({ id: folder.id, name: folder.name, itemIds: folderItems.filter((item) => item.folder_ordinal === folder.ordinal).map((item) => item.item_id) })), statusDays: statusDays.map((day) => ({ date: day.local_date, status: day.status })) })])
    }
    await initializeFamilyDocuments(mapping.familyId, true)
    const system = (await query("SELECT value FROM habittrove.setting_sections WHERE name='system'")).rows[0]?.value
    if (system) await query('UPDATE habittrove.family_settings SET settings=$2 WHERE family_id=$1', [mapping.familyId, JSON.stringify({ timezone: system.timezone, weekStartDay: system.weekStartDay })])
    await query('INSERT INTO habittrove.family_legacy_adoptions(source_hash,family_id,actor_id,mapping) VALUES($1,$2,$3,$4)', [preview.sourceHash, mapping.familyId, actor.id, JSON.stringify(mapping)])
    await audit(actor.id, mapping.familyId, 'legacy-data-adopted')
    return preview
  })
}

export async function readGlobalWalletBalance(actor: User, userId = actor.id, familyId?: string, options: { readOnly?: boolean } = {}): Promise<number> {
  const balance = async () => Number((await query('SELECT balance FROM habittrove.global_wallet_totals WHERE user_id=$1', [checkedId(userId)])).rows[0]?.balance ?? 0)
  // A global wallet remains available to its owner even after the final family membership ends.
  if (userId === actor.id) return withFreshFamilyActor(actor, balance, options)
  return withFamilyScope(actor, async (context) => {
    if (!context || !(context.isSiteAdmin || context.managedUserIds.includes(userId))) throw new Error('Wallet access denied')
    return balance()
  }, familyId, options)
}
