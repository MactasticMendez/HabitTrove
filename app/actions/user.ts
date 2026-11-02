"use server"

import { signIn as signInNextAuth, signOut as signOutNextAuth } from '@/auth';
import { cookies } from 'next/headers'
import { getCurrentUser } from '@/lib/server-helpers'
import { authenticateLocalUser } from '@/lib/auth-store'
import { authentikLinkCookie, createAuthentikLinkIntent } from '@/lib/authentik-link'
import { getActiveOidcConfig } from '@/lib/admin-config'

export async function signIn(username: string, password: string) {
  try {
    const result = await signInNextAuth("credentials", {
      username,
      password,
      redirect: false, // This needs to be passed as an option, not as form data
    });
    
    return result;
  } catch (error) {
    throw new Error("Invalid credentials");
  }
}

export async function signOut() {
  try {
    const result = await signOutNextAuth({
        redirect: false,
    })
  } catch (error) {
    throw new Error("Failed to sign out");
  }
}

export async function signInWithAuthentik() {
  const oidc = await getActiveOidcConfig()
  if (!oidc) {
    throw new Error('OIDC sign-in is not configured')
  }
  await signInNextAuth(oidc.providerId, { redirectTo: '/' })
}

export async function startAuthentikLink(_previous: { error: string }, formData: FormData): Promise<{ error: string }> {
  const oidc = await getActiveOidcConfig()
  if (!oidc) {
    return { error: 'OIDC sign-in is not configured' }
  }
  const user = await getCurrentUser()
  const password = formData.get('password')
  if (!user?.email || !user.password || user.authentikSubject || typeof password !== 'string' || password.length > 128) {
    return { error: 'Add an email and local password before linking' }
  }
  const verified = await authenticateLocalUser(user.username, password)
  if (!verified || verified.id !== user.id) return { error: 'Current password is incorrect' }

  const intent = createAuthentikLinkIntent(user.id, user.authVersion ?? 0, user.email.toLowerCase(), process.env.AUTH_SECRET ?? '')
  ;(await cookies()).set(authentikLinkCookie, intent, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/api/auth/callback/${oidc.providerId}`,
    maxAge: 300,
  })
  await signInNextAuth(oidc.providerId, { redirectTo: '/settings' })
  return { error: '' }
}
