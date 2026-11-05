'use server'

import { cookies } from 'next/headers'
import { getCurrentUser } from '@/lib/server-helpers'
import { sendFamilyInvitation } from '@/lib/invitation-mail'
import { getFamiliesEnabled, withFamilyScope } from '@/lib/family-scope'
import { acceptStoredHouseholdInvite, applyLegacyFamilyAdoption, issueHouseholdInvite, previewLegacyFamilyAdoption, previewStoredRemoval, provisionFamily, readFamilyState, readHouseholdInvites, readPublicHouseholdInvite, removeStoredMember, renameStoredFamily, revokeStoredInvite, updateStoredMembership } from '@/lib/family-store'
import type { FamilyRole, FamilyState, FamilySummary, LegacyFamilyMapping } from '@/lib/family-types'

async function actor() {
  const user = await getCurrentUser()
  if (!user) throw new Error('Unauthorized')
  if (!user.email) throw new Error('Email is required before using this account')
  if (process.env.DEMO === 'true') throw new Error('Family management is disabled in demo mode')
  return user
}
export async function loadFamilyState(): Promise<FamilyState> {
  return readFamilyState(await actor(), (await cookies()).get('habittrove-family')?.value)
}
export async function selectFamily(familyId: string): Promise<void> {
  await withFamilyScope(await actor(), async (context) => {
    if (!context) throw new Error('Family access denied')
  }, familyId)
  ;(await cookies()).set('habittrove-family', familyId, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 31536000 })
}
export async function createFamily(name: string, ownerId?: string): Promise<FamilySummary> {
  return provisionFamily(await actor(), name, ownerId)
}
export async function renameFamily(familyId: string, name: string): Promise<void> { return renameStoredFamily(await actor(), familyId, name) }
export async function updateFamilyMembership(familyId: string, userId: string, changes: { role?: FamilyRole; managedUserIds?: string[] }): Promise<void> { return updateStoredMembership(await actor(), familyId, userId, changes) }
export async function previewRemoveFamilyMember(familyId: string, userId: string) { return previewStoredRemoval(await actor(), familyId, userId) }
export async function removeFamilyMember(familyId: string, userId: string, expectedRevision?: string): Promise<void> { return removeStoredMember(await actor(), familyId, userId, expectedRevision) }
export async function createHouseholdInvite(familyId: string, email: string, role: 'member' | 'manager', managedBy?: string): Promise<{ token: string; sent: boolean }> {
  const result = await issueHouseholdInvite(await actor(), familyId, email, role, managedBy)
  // Delivery happens after commit and is never repeated by a retried database transaction.
  return { ...result, sent: await sendFamilyInvitation(email.trim().toLowerCase(), result.token).catch(() => false) }
}
export async function listHouseholdInvites(familyId: string) { return readHouseholdInvites(await actor(), familyId) }
export async function revokeHouseholdInvite(familyId: string, tokenHash: string): Promise<void> { return revokeStoredInvite(await actor(), familyId, tokenHash) }
export async function acceptExistingHouseholdInvite(token: string): Promise<void> { return acceptStoredHouseholdInvite(await actor(), token) }
export async function getHouseholdInvite(token: string) {
  if (!await getFamiliesEnabled()) return undefined
  return readPublicHouseholdInvite(token)
}
export async function previewExistingDataFamilyMapping(input: LegacyFamilyMapping) { return previewLegacyFamilyAdoption(await actor(), input) }
export async function applyExistingDataFamilyMapping(input: LegacyFamilyMapping) { return applyLegacyFamilyAdoption(await actor(), input) }
