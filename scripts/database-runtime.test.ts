import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('..', import.meta.url))
const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'production', TZ: 'UTC' }

async function copyPostgresDependencies(target: string) {
  const copied = new Set<string>()
  async function copy(name: string, parent: string) {
    if (copied.has(name)) return
    copied.add(name)
    let directory = path.dirname(createRequire(path.join(parent, 'package.json')).resolve(name))
    let metadata: { name: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
    while (true) {
      try {
        metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
        if (metadata.name === name) break
      } catch { /* An entry point may be nested below its package metadata. */ }
      const next = path.dirname(directory)
      if (next === directory) throw new Error('PostgreSQL dependency metadata not found')
      directory = next
    }
    // Bun's default recursive copy can stall on npm-installed trees on macOS.
    await fs.cp(directory, path.join(target, name), { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
    for (const dependency of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies })) await copy(dependency, directory)
  }
  await copy('pg', repository)
}

function node(args: string[], cwd: string) {
  return spawnSync('node', args, { cwd, env: environment, encoding: 'utf8', timeout: 20_000 })
}

test('compiled CLI imports and dry-runs read-only source with only standalone PostgreSQL dependencies', async () => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'habittrove-cli-runtime-'))
  const source = path.join(directory, 'source')
  try {
    const buildDirectory = path.join(directory, 'build')
    await fs.mkdir(buildDirectory)
    await fs.symlink(path.join(repository, 'scripts'), path.join(buildDirectory, 'scripts'), 'dir')
    await fs.symlink(path.join(repository, 'lib'), path.join(buildDirectory, 'lib'), 'dir')
    const built = node([path.join(repository, 'scripts/build-database.mjs')], buildDirectory)
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
    await fs.cp(path.join(buildDirectory, 'dist'), path.join(directory, 'dist'), { recursive: true })
    await fs.mkdir(path.join(directory, 'scripts'))
    await fs.copyFile(path.join(repository, 'scripts/database.mjs'), path.join(directory, 'scripts/database.mjs'))
    // Next traces pg for the server; CLI-only packages must be inside the bundles themselves.
    await copyPostgresDependencies(path.join(directory, 'node_modules'))
    for (const dependency of ['uuid', 'zod', 'json-stable-stringify']) {
      expect(await fs.access(path.join(directory, 'node_modules', dependency)).then(() => true, () => false)).toBe(false)
    }
    const imported = node(['--input-type=module', '-e', `
      const database = await import('./dist/database.mjs')
      const recovery = await import('./dist/database-recovery.mjs')
      if (typeof database.databaseCommand !== 'function' || typeof recovery.setDatabasePassword !== 'function') throw Error('Missing offline entry point')
    `], directory)
    expect({ status: imported.status, stderr: imported.stderr }).toEqual({ status: 0, stderr: '' })

    await fs.mkdir(source)
    const documents = {
      auth: { users: [{ id: 'preserved-admin', username: 'admin', password: 'retained-password-hash', isAdmin: true }] },
      habits: { habits: [] }, wishlist: { items: [] }, coins: { balance: 0, transactions: [] },
      settings: { ui: { useNumberFormatting: true, useGrouping: true }, system: { timezone: 'UTC', weekStartDay: 1, language: 'en', autoBackupEnabled: true }, profile: {} },
    }
    for (const [name, value] of Object.entries(documents)) await fs.writeFile(path.join(source, `${name}.json`), JSON.stringify(value), { mode: 0o400 })
    await fs.chmod(source, 0o500)
    const manifest = path.join(directory, 'manifest.json')
    const result = node(['scripts/database.mjs', 'dry-run', source, '--manifest', manifest], directory)
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({ format: 'habittrove-snapshot', version: 1, assetCount: 0 })
    expect((await fs.stat(manifest)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await fs.readFile(manifest, 'utf8')).externalSecretsRequired).toEqual(['AUTH_SECRET'])
    expect((await fs.readdir(source)).sort()).toEqual(Object.keys(documents).map(name => `${name}.json`).sort())
    for (const [name, value] of Object.entries(documents)) expect(await fs.readFile(path.join(source, `${name}.json`), 'utf8')).toBe(JSON.stringify(value))
  } finally {
    await fs.chmod(source, 0o700).catch(() => {})
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)
