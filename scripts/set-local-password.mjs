import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const mode = process.env.HABITTROVE_STORAGE
if (mode && !['postgres', 'legacy-json'].includes(mode)) throw new Error('Invalid storage selection')
if (!process.env.DATABASE_URL && (mode === 'postgres' || process.env.NODE_ENV === 'production' && process.env.DEMO !== 'true' || !['test', 'development'].includes(process.env.NODE_ENV) && process.env.DEMO !== 'true' && mode !== 'legacy-json')) {
  throw new Error('DATABASE_URL is required; JSON recovery requires explicit development/test storage')
}
const username = process.argv[2]
if (process.argv.slice(3).some(flag => flag !== '--allow-test-database')) throw new Error('Unknown recovery option')
if (!username || !/^[a-zA-Z0-9]{3,20}$/.test(username)) {
  throw new Error('Usage: node scripts/set-local-password.mjs USERNAME < password-on-stdin')
}

const chunks = []
let inputBytes = 0
for await (const chunk of process.stdin) {
  inputBytes += chunk.length
  if (inputBytes > 512) throw new Error('Password must be 12-128 characters')
  chunks.push(chunk)
}
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
if (password.length < 12 || password.length > 128) {
  throw new Error('Password must be 12-128 characters')
}

const salt = randomBytes(16).toString('hex')
const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
if (process.env.DATABASE_URL) {
  try {
    const { setDatabasePassword } = await import('../dist/database-recovery.mjs')
    await setDatabasePassword(username, passwordHash, process.argv.includes('--allow-test-database'))
    console.log('Local password updated; prior credential document saved privately in backups')
  } catch {
    console.error('Database password recovery failed; check the explicit target, runtime bundle, account, and database availability')
    process.exitCode = 1
  }
} else {
  const authPath = path.join(process.cwd(), 'data', 'auth.json')
  const original = await fs.readFile(authPath, 'utf8')
  const data = JSON.parse(original)
  if (!Array.isArray(data.users)) throw new Error('Invalid account data')
  const user = data.users.find(candidate => candidate.username === username)
  if (!user) throw new Error('User not found')

  const backupPath = `${authPath}.before-password-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await fs.writeFile(backupPath, original, { flag: 'wx', mode: 0o600 })

  user.password = passwordHash
  user.authVersion = (user.authVersion ?? 0) + 1
  const temporary = `${authPath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, authPath)
  } finally {
    await fs.rm(temporary, { force: true })
  }

  console.log(`Updated ${username}; backup: ${backupPath}`)

}
