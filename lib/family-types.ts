export type FamilyRole = 'owner' | 'manager' | 'member'
export type FamilySummary = { id: string; name: string; role: FamilyRole | 'site-admin'; memberCount: number }
export type FamilyMemberInfo = { id: string; username: string; role: FamilyRole; active: boolean; managedUserIds: string[] }
export type FamilyState = { families: FamilySummary[]; selectedFamilyId?: string; members: FamilyMemberInfo[]; familiesEnabled: boolean }
export type FamilyContext = {
  familyId: string; actorId: string; isSiteAdmin: boolean; role: FamilyRole | 'site-admin'; memberIds: string[]; managedUserIds: string[]
}
export type FamilyRemovalImpact = {
  familyId: string; userId: string; revision: string; archivedItemIds: string[]; archivedHabitIds: string[]; archivedRewardIds: string[]; withdrawnSubmissionIds: string[];
  reassignedApproverItemIds: string[]; removedDelegations: number; walletRetained: true; historyRetained: true
}
export type HouseholdInviteInfo = {
  tokenHash: string; email: string; role: 'member' | 'manager'; managedBy?: string; expiresAt: string; createdBy: string;
  consumed: boolean; revoked: boolean
}
export type PublicHouseholdInvite = { familyName: string; maskedEmail: string; role: 'member' | 'manager'; expiresAt: string }
export type LegacyFamilyMapping = {
  familyId: string; userIds: string[]; habitIds: string[]; wishlistIds: string[]; ledgerIds: string[];
  managers: { managerId: string; memberId: string }[]; expectedSourceHash?: string
}
export type LegacyFamilyMappingPreview = { sourceHash: string; users: number; habits: number; rewards: number; transactions: number; legacyManagerAssignments: { managerId: string; memberId: string }[]; discardedLegacyManagerAssignments: { managerId: string; memberId: string }[] }
