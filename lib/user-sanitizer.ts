import { PublicUserData, UserData } from './types'

export function sanitizeUserData(data: UserData, viewerId?: string, isAdmin = false): PublicUserData {
  return {
    users: data.users.map(({ password, authentikSubject, oidcIssuer, authVersion, email, personalFolders, statusDays, managedUserIds, personalSettings, ...user }) => ({
      ...user,
      ...((isAdmin || user.id === viewerId) && email ? { email } : {}),
      ...(user.id === viewerId && { personalFolders, statusDays, personalSettings }),
      ...((isAdmin || user.id === viewerId) && { managedUserIds }),
      hasPassword: !!password,
      hasAuthentik: !!authentikSubject,
    })),
  }
}
