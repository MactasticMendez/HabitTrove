import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const username = process.argv[2]
if (!username || !/^[a-zA-Z0-9]{3,20}$/.test(username)) {
  throw new Error('Usage: node scripts/set-local-password.mjs USERNAME < password-on-stdin')
}

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
if (password.length < 12 || password.length > 128) {
  throw new Error('Password must be 12-128 characters')
}

const authPath = path.join(process.cwd(), 'data', 'auth.json')
const original = await fs.readFile(authPath, 'utf8')
const data = JSON.parse(original)
if (!Array.isArray(data.users)) throw new Error('Invalid account data')
const user = data.users.find(candidate => candidate.username === username)
if (!user) throw new Error('User not found')

const backupPath = `${authPath}.before-password-${new Date().toISOString().replace(/[:.]/g, '-')}`
await fs.writeFile(backupPath, original, { flag: 'wx', mode: 0o600 })

const salt = randomBytes(16).toString('hex')
user.password = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
user.authVersion = (user.authVersion ?? 0) + 1
const temporary = `${authPath}.${randomUUID()}.tmp`
try {
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 })
  await fs.rename(temporary, authPath)
} finally {
  await fs.rm(temporary, { force: true })
}

console.log(`Updated ${username}; backup: ${backupPath}`)
