import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import type { Provider } from 'next-auth/providers'
import { authenticateLocalUser, findUserByAuthentikSubject, findUserById, linkUserToAuthentikSubject, userMatchesOidcIdentity } from './lib/auth-store'
import { signInSchema } from './lib/zod'
import { cookies } from 'next/headers'
import { authentikLinkCookie, verifyAuthentikLinkIntent } from './lib/authentik-link'
import { getActiveOidcConfig, type OidcConfig } from './lib/admin-config'

export function providersFor(oidc?: OidcConfig): Provider[] {
  const providers: Provider[] = [
  Credentials({
    credentials: { username: {}, password: {} },
    authorize: async credentials => {
      const parsed = signInSchema.safeParse(credentials)
      if (!parsed.success) return null
      const user = await authenticateLocalUser(parsed.data.username, parsed.data.password ?? '')
      return user ? { id: user.id, authVersion: user.authVersion ?? 0 } : null
    },
  }),
  ]

  if (oidc) providers.push({
    id: oidc.providerId,
    name: 'OIDC',
    type: 'oidc',
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    checks: ['pkce', 'state', 'nonce'],
    authorization: { params: { scope: 'openid profile email' } },
    profile: async profile => {
      if (typeof profile.sub !== 'string' || !profile.sub) throw new Error('Invalid identity')
      let user = await findUserByAuthentikSubject(profile.sub, oidc.issuer)
      if (!user) {
        const intent = verifyAuthentikLinkIntent((await cookies()).get(authentikLinkCookie)?.value, process.env.AUTH_SECRET ?? '')
        if (!intent || profile.email_verified !== true || typeof profile.email !== 'string' ||
            profile.email.trim().toLowerCase() !== intent.email) {
          throw new Error('OIDC account is not linked')
        }
        user = await linkUserToAuthentikSubject(intent.userId, intent.authVersion, intent.email, profile.sub, oidc.issuer)
      }
      return { id: profile.sub, localUserId: user.id, authVersion: user.authVersion ?? 0 }
    },
  })
  return providers
}

export const { handlers, signIn, signOut, auth } = NextAuth(async () => ({
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 24 * 60 * 60 },
  providers: providersFor(await getActiveOidcConfig()),
  callbacks: {
    jwt: async ({ token, user, account }) => {
      if (user) {
        const oidcAccount = account?.provider === 'authentik' || account?.provider === 'oidc'
        const userId = oidcAccount
          ? 'localUserId' in user ? user.localUserId : undefined
          : user.id
        if (typeof userId !== 'string') return null
        const current = await findUserById(userId)
        const authVersion = 'authVersion' in user ? user.authVersion : undefined
        if (!current || typeof authVersion !== 'number' ||
            (current.authVersion ?? 0) !== authVersion ||
            (oidcAccount && (!account?.providerAccountId ||
              !await userMatchesOidcIdentity(current, account.providerAccountId, (await getActiveOidcConfig())?.issuer ?? '')))) return null
        token.id = current.id
        token.authVersion = current.authVersion ?? 0
        return token
      }
      if (typeof token.id !== 'string' || typeof token.authVersion !== 'number') return null
      const current = await findUserById(token.id)
      return current && (current.authVersion ?? 0) === token.authVersion ? token : null
    },
    session: async ({ session, token }) => {
      if (session.user && typeof token.id === 'string') {
        session.user.id = token.id
        session.user.email = ''
        session.user.name = null
        session.user.image = null
      }
      return session
    },
  },
}))
