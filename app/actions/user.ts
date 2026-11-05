"use server"

import { signIn as signInNextAuth, signOut as signOutNextAuth } from '@/auth';
import { cookies } from 'next/headers'
import { getCurrentUser } from '@/lib/server-helpers'
import { verifyStepUpPassword } from '@/lib/auth-store'
import { oidcLinkCookie, createOidcLinkIntent } from '@/lib/oidc-link'
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

export async function signInWithOidc(redirectTo: string = '/') {
  if (typeof redirectTo !== 'string' || redirectTo !== '/' && !/^\/invite\/[A-Za-z0-9_-]{32,128}$/.test(redirectTo)) {
    throw new Error('Invalid sign-in return path')
  }
  const oidc = await getActiveOidcConfig()
  if (!oidc) {
    throw new Error('OIDC sign-in is not configured')
  }
  await signInNextAuth(oidc.providerId, { redirectTo })
}

export async function startOidcLink(_previous: { error: string }, formData: FormData): Promise<{ error: string }> {
  const oidc = await getActiveOidcConfig()
  if (!oidc) {
    return { error: 'OIDC sign-in is not configured' }
  }
  const user = await getCurrentUser()
  const password = formData.get('password')
  if (!user?.email || !user.password || user.oidcSubject || typeof password !== 'string' || password.length > 128) {
    return { error: 'Add an email and local password before linking' }
  }
  if (!(await verifyStepUpPassword(user, password))) return { error: 'Current password is incorrect' }

  const intent = createOidcLinkIntent(user.id, user.authVersion ?? 0, user.email.toLowerCase(), process.env.AUTH_SECRET ?? '')
  ;(await cookies()).set(oidcLinkCookie, intent, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/api/auth/callback/${oidc.providerId}`,
    maxAge: 300,
  })
  await signInNextAuth(oidc.providerId, { redirectTo: '/settings' })
  return { error: '' }
}
