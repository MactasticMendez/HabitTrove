import { expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectRepositoryFile } from './check-repository-privacy.mjs'

const script = fileURLToPath(new URL('./check-repository-privacy.mjs', import.meta.url))

test('permits reserved example contacts, documentation networks, source schemas and lockfile integrity', () => {
  const examples = 'admin@example.com person@example.net user@example.org account@demo.test user@host.invalid'
  const networks = '127.0.0.1 127.255.255.254 0.0.0.0 192.0.2.1 198.51.100.25 203.0.113.254'
  expect(inspectRepositoryFile('README.md', `${examples}\n${networks}`)).toEqual([])
  expect(inspectRepositoryFile('.env.example', 'SMTP_FROM=admin@example.com')).toEqual([])
  expect(inspectRepositoryFile('lib/db/schema.sql', 'CREATE TABLE users (id text);')).toEqual([])
  expect(inspectRepositoryFile('package-lock.json', JSON.stringify({ integrity: 'sha512-' + 'a'.repeat(80) }))).toEqual([])
  expect(inspectRepositoryFile('lib/auth.ts', 'const apiKey = process.env.API_KEY; const password = input.password')).toEqual([])
  expect(inspectRepositoryFile('scripts/database.test.ts', 'postgresql://db-user:fixture-password@127.0.0.1/example')).toEqual([])
})

test('rejects non-reserved contact addresses and network addresses without returning their values', () => {
  const contact = 'operator' + '@' + 'privacy-check.example'
  const network = ['10', '19', '27', '31'].join('.')
  const issues = inspectRepositoryFile('README.md', `${contact} ${contact} ${network}`)
  expect(issues).toEqual(['non-reserved email address', 'non-reserved IPv4 address'])
  expect(JSON.stringify(issues)).not.toContain(contact)
  expect(JSON.stringify(issues)).not.toContain(network)
  expect(inspectRepositoryFile('README.md', 'admin@example.com.' + 'outside.example')).toContain('non-reserved email address')
  expect(inspectRepositoryFile('README.md', 'invalid version 999.999.999.999')).toEqual([])
})

test('rejects private and generated paths before skipping binary contents', () => {
  for (const file of ['data/auth.json', 'data.before-migration/auth.json', 'backups/export.zip', 'uploads/avatar.png']) {
    expect(inspectRepositoryFile(file, Buffer.from([0, 1]))).toContain('runtime data or backup file')
  }
  for (const file of ['.env', '.env.local', 'deployment/.env.production']) {
    expect(inspectRepositoryFile(file, '')).toContain('environment configuration')
  }
  for (const file of ['server.pem', 'server.key', 'server.crt', 'server.p12']) {
    expect(inspectRepositoryFile(file, Buffer.from([0, 1]))).toContain('private key or certificate file')
  }
  for (const file of ['database.sqlite', 'export.dump', 'backup.sql.gz', 'export.sql', 'snapshot.tgz', 'auth.json.before-password-123']) {
    expect(inspectRepositoryFile(file, Buffer.from([0, 1]))).toContain('database dump or backup file')
  }
  for (const file of ['.next/server/app.js', 'dist/database.mjs', 'coverage/result.json', 'debug.log', 'types.tsbuildinfo']) {
    expect(inspectRepositoryFile(file, '')).toContain('generated build or log file')
  }
  expect(inspectRepositoryFile('public/icon.png', Buffer.from([0, 1, 2]))).toEqual([])
})

test('rejects private key material and common credential formats without returning secret values', () => {
  const key = ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'].join('')
  const tokens = [
    ['ghp', '_', 'a'.repeat(36)].join(''),
    ['github', '_pat_', 'a'.repeat(60)].join(''),
    ['AK', 'IA', 'A'.repeat(16)].join(''),
    ['xox', 'b-', '1234567890-1234567890-', 'a'.repeat(24)].join(''),
    ['sk', '_live_', 'a'.repeat(24)].join(''),
    ['sk', '-proj-', 'a'.repeat(40)].join(''),
  ]
  expect(inspectRepositoryFile('notes.md', key)).toContain('private key material')
  for (const token of tokens) {
    const issues = inspectRepositoryFile('notes.md', token)
    expect(issues).toContain('credential token')
    expect(JSON.stringify(issues)).not.toContain(token)
  }
  const dump = ['-- PostgreSQL database ', 'dump'].join('')
  expect(inspectRepositoryFile('notes.txt', dump)).toContain('database dump contents')
  const alternateDump = ['-- MySQL ', 'dump 10.13'].join('')
  expect(inspectRepositoryFile('notes.txt', alternateDump)).toContain('database dump contents')
})

test('CLI checks tracked additions, ignores untracked files and never prints matched contents', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'repository-privacy-'))
  const contact = 'operator' + '@' + 'privacy-check.example'
  try {
    execFileSync('git', ['init', '--quiet', directory])
    writeFileSync(path.join(directory, 'README.md'), 'admin@example.com 192.0.2.1')
    writeFileSync(path.join(directory, '.env.local'), contact)
    execFileSync('git', ['add', 'README.md'], { cwd: directory })
    const clean = spawnSync('node', [script], { cwd: directory, encoding: 'utf8' })
    expect(clean.status).toBe(0)
    writeFileSync(path.join(directory, 'notes.md'), contact)
    execFileSync('git', ['add', 'notes.md'], { cwd: directory })
    const unsafe = spawnSync('node', [script], { cwd: directory, encoding: 'utf8' })
    expect(unsafe.status).toBe(1)
    expect(unsafe.stdout + unsafe.stderr).toContain('notes.md')
    expect(unsafe.stdout + unsafe.stderr).toContain('non-reserved email address')
    expect(unsafe.stdout + unsafe.stderr).not.toContain(contact)
    expect(unsafe.stdout + unsafe.stderr).not.toContain('.env.local')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI does not follow a tracked symbolic link to private untracked files', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'repository-privacy-link-'))
  try {
    execFileSync('git', ['init', '--quiet', directory])
    mkdirSync(path.join(directory, 'private'))
    writeFileSync(path.join(directory, 'private', 'notes.txt'), 'private-content-sentinel')
    symlinkSync(path.join(directory, 'private', 'notes.txt'), path.join(directory, 'notes.md'))
    execFileSync('git', ['add', 'notes.md'], { cwd: directory })
    const result = spawnSync('node', [script], { cwd: directory, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('tracked symbolic link')
    expect(result.stdout + result.stderr).not.toContain('private-content-sentinel')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
