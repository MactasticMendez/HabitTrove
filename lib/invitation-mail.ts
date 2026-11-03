import 'server-only'
import nodemailer from 'nodemailer'
import { readSmtpConfig } from './admin-config'

export async function sendFamilyInvitation(email: string, token: string): Promise<boolean> {
  const smtp = await readSmtpConfig()
  if (!smtp || !process.env.AUTH_URL) return false
  const invitationUrl = new URL(`/invite/${encodeURIComponent(token)}`, process.env.AUTH_URL).href
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  try {
    await transporter.sendMail({
      from: smtp.from,
      to: email,
      subject: 'Your HabitTrove family invitation',
      text: `You have been invited to HabitTrove. Create your account using this one-use link within seven days:\n\n${invitationUrl}\n\nIf you were not expecting this invitation, you can ignore this message.`,
    })
    return true
  } catch {
    return false
  } finally {
    transporter.close()
  }
}
