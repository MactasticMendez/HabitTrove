import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import type { Provider } from 'next-auth/providers'
import { authenticateLocalUser, findUserByAuthentikSubject, findUserById, linkUserToAuthentikSubject } from './lib/auth-store'
import { signInSchema } from './lib/zod'
import type { SessionUser } from './lib/types'
import { cookies } from 'next/headers'
import { authentikLinkCookie, verifyAuthentikLinkIntent } from './lib/authentik-link'

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

if (process.env.AUTHENTIK_ISSUER && process.env.AUTHENTIK_CLIENT_ID && process.env.AUTHENTIK_CLIENT_SECRET) {
  providers.push({
    id: 'authentik',
    name: 'Authentik',
    type: 'oidc',
    issuer: process.env.AUTHENTIK_ISSUER,
    clientId: process.env.AUTHENTIK_CLIENT_ID,
    clientSecret: process.env.AUTHENTIK_CLIENT_SECRET,
    checks: ['pkce', 'state', 'nonce'],
    authorization: { params: { scope: 'openid profile email' } },
    profile: async profile => {
      if (typeof profile.sub !== 'string' || !profile.sub) throw new Error('Invalid identity')
      let user = await findUserByAuthentikSubject(profile.sub)
      if (!user) {
        const intent = verifyAuthentikLinkIntent((await cookies()).get(authentikLinkCookie)?.value, process.env.AUTH_SECRET ?? '')
        if (!intent || profile.email_verified !== true || typeof profile.email !== 'string' ||
            profile.email.trim().toLowerCase() !== intent.email) {
          throw new Error('Authentik account is not linked')
        }
        user = await linkUserToAuthentikSubject(intent.userId, intent.authVersion, intent.email, profile.sub)
      }
      return { id: user.id, authVersion: user.authVersion ?? 0 }
    },
  })
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 24 * 60 * 60 },
  providers,
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) {
        token.id = user.id
        token.authVersion = (user as SessionUser).authVersion ?? 0
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
})
