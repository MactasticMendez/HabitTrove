import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from 'pg'
import { afterStorageCommit, closeDatabase, withStorageTransaction } from './db/client'
import { readAttachmentMetadata } from './db/repository'
import type { User } from './types'

let actor: User | undefined
let selectedFamily: string | undefined
let registerAttachment: typeof import('./attachment-store')['registerAttachment']
let scheduleAttachmentRemoval: typeof import('./attachment-store')['scheduleAttachmentRemoval']
let evidence: typeof import('../app/api/evidence/[id]/route')
let avatars: typeof import('../app/api/avatars/[...path]/route')
const id = '11111111-1111-4111-8111-111111111111'
const bytes = Buffer.from('protected image fixture')
const digest = createHash('sha256').update(bytes).digest('hex')
const user = (id: string): User => ({ id, username: id, email: `${id}@example.test`, authVersion: 0 })
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname === '/habittrove_test_media'
let admin: Client
let directory: string
let cwdSpy: ReturnType<typeof spyOn>
const getEvidence = (value = id) => evidence.GET(new Request(`http://localhost/api/evidence/${value}`), { params: Promise.resolve({ id: value }) })
const getAvatar = (segments: string[]) => avatars.GET(new Request(`http://localhost/api/avatars/${segments.join('/')}`), { params: Promise.resolve({ path: segments }) })

describe.skipIf(!enabled)('protected assets (dedicated local PostgreSQL restricted-role fixture)', () => {
  beforeAll(async () => {
    mock.module('server-only', () => ({}))
    mock.module('@/lib/server-helpers', () => ({ getCurrentUser: async () => actor }))
    mock.module('next/headers', () => ({ cookies: async () => ({ get: () => selectedFamily ? { value: selectedFamily } : undefined }) }))
    ;({ registerAttachment, scheduleAttachmentRemoval } = await import('./attachment-store'))
    evidence = await import('../app/api/evidence/[id]/route')
    avatars = await import('../app/api/avatars/[...path]/route')
    const target = new URL(process.env.DATABASE_MIGRATION_URL!)
    if (target.hostname !== '127.0.0.1' || target.port !== '15432' || target.pathname !== '/habittrove_test_media') throw new Error('Dedicated local media fixture required')
    admin = new Client({ connectionString: target.toString() })
    await admin.connect()
    if (!(await admin.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0].name) {
      await admin.query('BEGIN')
      await admin.query(await fs.readFile(new URL('./db/family-schema.sql', import.meta.url), 'utf8'))
      await admin.query('COMMIT')
    }
    await admin.query(`GRANT SELECT ON habittrove.family_configuration,habittrove.families,habittrove.family_memberships,habittrove.family_manager_assignments,habittrove.household_invitations TO "Mac89Habittrove"`)
    for (const id of ['a', 'b', 'dual', 'member', 'solo']) await admin.query("INSERT INTO habittrove.users(id,ordinal,username,email,auth_version,attributes) VALUES($1,0,$1,$2,0,'{}') ON CONFLICT(id) DO NOTHING", [id, `${id}@example.test`])
    await admin.query("INSERT INTO habittrove.families(id,name) VALUES('A','Family A'),('B','Family B') ON CONFLICT DO NOTHING")
    await admin.query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES('A','a','owner'),('B','b','owner'),('A','dual','member'),('B','dual','member'),('A','member','member') ON CONFLICT DO NOTHING")
    await admin.query("INSERT INTO habittrove.habits(id,ordinal,name,created_by,coin_reward,attributes,family_id) VALUES('ha',0,'Habit A','a',1,'{}','A') ON CONFLICT DO NOTHING")
    await admin.query("INSERT INTO habittrove.habit_approvers(habit_id,ordinal,user_id,family_id) VALUES('ha',0,'dual','A') ON CONFLICT DO NOTHING")
  })
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-media-'))
    cwdSpy = spyOn(process, 'cwd').mockReturnValue(directory)
    await fs.mkdir(path.join(directory, 'data', 'evidence'), { recursive: true })
    await fs.mkdir(path.join(directory, 'data', 'avatars'), { recursive: true })
    await fs.writeFile(path.join(directory, 'data', 'evidence', `${id}.png`), bytes)
    await fs.writeFile(path.join(directory, 'data', 'habits.json'), JSON.stringify({ habits: [] }))
    await admin.query('UPDATE habittrove.family_configuration SET enabled=false')
    await admin.query("UPDATE habittrove.family_memberships SET active=true WHERE user_id='dual'")
    await admin.query('UPDATE habittrove.users SET auth_version=0,attributes=$1', [JSON.stringify({ fields: {} })])
    await admin.query('DELETE FROM habittrove.attachments')
    await admin.query('DELETE FROM habittrove.completions')
    await admin.query("INSERT INTO habittrove.completions(habit_id,ordinal,id,actor_id,record_kind,evidence_id,evidence_mime,approval,attributes,family_id) VALUES('ha',0,$1,'member','record',$1,'image/png','pending','{}','A')", [id])
    await admin.query("INSERT INTO habittrove.attachments(id,habit_id,completion_id,owner_id,path,mime_type,sha256,family_id) VALUES($1,'ha',$1,'member',$2,'image/png',$3,'A')", [id, `evidence/${id}.png`, digest])
    actor = user('dual')
    selectedFamily = 'A'
  })
  afterEach(async () => { cwdSpy?.mockRestore(); await fs.rm(directory, { recursive: true, force: true }) })
  afterAll(async () => { await closeDatabase(); await admin?.end() })

  test('Stage A evidence authorization uses database metadata and records, never stale JSON', async () => {
    expect((await getEvidence()).status).toBe(200)
    actor = user('member'); expect((await getEvidence()).status).toBe(200)
    actor = user('a'); expect((await getEvidence()).status).toBe(200)
    actor = user('b'); expect((await getEvidence()).status).toBe(404)
    actor = undefined; expect((await getEvidence()).status).toBe(401)
    actor = user('dual')
    await admin.query('DELETE FROM habittrove.attachments WHERE id=$1', [id])
    expect((await getEvidence()).status).toBe(404)
  })
  test('voided and tampered evidence is hidden; rejected evidence retains prior viewing policy', async () => {
    await admin.query("UPDATE habittrove.completions SET approval='rejected'")
    expect((await getEvidence()).status).toBe(200)
    await admin.query('UPDATE habittrove.completions SET voided=true')
    expect((await getEvidence()).status).toBe(404)
    await admin.query('UPDATE habittrove.completions SET voided=false')
    await fs.writeFile(path.join(directory, 'data', 'evidence', `${id}.png`), 'changed')
    expect((await getEvidence()).status).toBe(404)
  })
  test('attachment registration hashes bytes; removal rolls back and only cleans after commit', async () => {
    await expect(withStorageTransaction(async () => { await scheduleAttachmentRemoval(id, `evidence/${id}.png`); throw new Error('abort') })).rejects.toThrow('abort')
    expect(await readAttachmentMetadata(id)).toBeDefined()
    expect(await fs.readFile(path.join(directory, 'data', 'evidence', `${id}.png`))).toEqual(bytes)
    await scheduleAttachmentRemoval(id, `evidence/${id}.png`)
    expect(await readAttachmentMetadata(id)).toBeUndefined()
    await expect(fs.stat(path.join(directory, 'data', 'evidence', `${id}.png`))).rejects.toThrow()
    await fs.writeFile(path.join(directory, 'data', 'avatars', 'solo.png'), bytes)
    await registerAttachment({ id: 'avatar:solo.png', path: 'avatars/solo.png', owner_id: 'solo', mime_type: 'image/png', bytes })
    expect((await readAttachmentMetadata('avatar:solo.png'))?.sha256).toBe(digest)
  })
  test('cleanup failure cannot turn a committed removal into a failed retry', async () => {
    const filename = path.join(directory, 'data', 'evidence', `${id}.png`)
    await fs.unlink(filename)
    await fs.symlink(path.join(directory, 'data', 'habits.json'), filename)
    await scheduleAttachmentRemoval(id, `evidence/${id}.png`)
    expect(await readAttachmentMetadata(id)).toBeUndefined()
    expect((await fs.lstat(filename)).isSymbolicLink()).toBe(true)
  })
  test('attachment registration and removal reject traversal and symlinks', async () => {
    await expect(scheduleAttachmentRemoval(id, 'evidence/../../auth.json')).rejects.toThrow('path')
    const filename = path.join(directory, 'data', 'avatars', 'solo.png')
    await fs.symlink(path.join(directory, 'data', 'habits.json'), filename)
    await expect(registerAttachment({ id: 'avatar:solo.png', path: 'avatars/solo.png', owner_id: 'solo', mime_type: 'image/png', bytes })).rejects.toThrow('file')
  })
  test('Stage B evidence requires fresh selected membership and denies inaccessible metadata', async () => {
    await admin.query('UPDATE habittrove.family_configuration SET enabled=true')
    expect((await getEvidence()).status).toBe(200)
    selectedFamily = 'B'; expect((await getEvidence()).status).toBe(404)
    selectedFamily = undefined; expect((await getEvidence()).status).toBe(404)
    selectedFamily = 'A'
    await admin.query("UPDATE habittrove.family_memberships SET active=false WHERE user_id='dual' AND family_id='A'")
    expect((await getEvidence()).status).toBe(404)
    await admin.query("UPDATE habittrove.family_memberships SET active=true WHERE user_id='dual' AND family_id='A'")
    await admin.query('UPDATE habittrove.attachments SET inaccessible=true')
    expect((await getEvidence()).status).toBe(404)
  })
  test('Stage B cleanup restores and freshly validates the original family scope', async () => {
    await admin.query('UPDATE habittrove.family_configuration SET enabled=true')
    const { withFamilyScope } = await import('./family-scope')
    await withFamilyScope(user('dual'), async () => scheduleAttachmentRemoval(id, `evidence/${id}.png`), 'A')
    expect((await admin.query('SELECT 1 FROM habittrove.attachments WHERE id=$1', [id])).rowCount).toBe(0)
    await expect(fs.stat(path.join(directory, 'data', 'evidence', `${id}.png`))).rejects.toThrow()
  })
  test('revocation after commit leaves an inaccessible orphan without failing the committed write', async () => {
    await admin.query('UPDATE habittrove.family_configuration SET enabled=true')
    const { withFamilyScope } = await import('./family-scope')
    await withFamilyScope(user('dual'), async () => {
      await afterStorageCommit(async () => { await admin.query("UPDATE habittrove.family_memberships SET active=false WHERE user_id='dual' AND family_id='A'") })
      await scheduleAttachmentRemoval(id, `evidence/${id}.png`)
    }, 'A')
    expect((await admin.query('SELECT 1 FROM habittrove.attachments WHERE id=$1', [id])).rowCount).toBe(0)
    expect(await fs.readFile(path.join(directory, 'data', 'evidence', `${id}.png`))).toEqual(bytes)
    expect((await getEvidence()).status).toBe(404)
  })
  test('Stage B avatar directory is selected-family scoped with global own avatar for no-membership accounts', async () => {
    for (const owner of ['a', 'b', 'solo']) {
      await fs.writeFile(path.join(directory, 'data', 'avatars', `${owner}.png`), bytes)
      await admin.query("INSERT INTO habittrove.attachments(id,owner_id,path,mime_type,sha256) VALUES($1,$2,$3,'image/png',$4)", [`avatar:${owner}.png`, owner, `avatars/${owner}.png`, digest])
    }
    await admin.query('UPDATE habittrove.family_configuration SET enabled=true')
    expect((await getAvatar(['a.png'])).status).toBe(200)
    expect((await getAvatar(['b.png'])).status).toBe(404)
    selectedFamily = 'B'; expect((await getAvatar(['b.png'])).status).toBe(200)
    expect((await getAvatar(['a.png'])).status).toBe(404)
    actor = user('solo'); selectedFamily = undefined
    expect((await getAvatar(['solo.png'])).status).toBe(200)
    expect((await getAvatar(['a.png'])).status).toBe(404)
    actor = user('dual'); expect((await getAvatar(['a.png'])).status).toBe(404)
  })
  test('Stage B legacy nested avatars require an exact active directory reference', async () => {
    await fs.mkdir(path.join(directory, 'data', 'avatars', 'legacy'))
    await fs.writeFile(path.join(directory, 'data', 'avatars', 'legacy', 'old.png'), bytes)
    await admin.query('UPDATE habittrove.users SET attributes=$1 WHERE id=$2', [JSON.stringify({ fields: { avatarPath: '/data/avatars/legacy/old.png' } }), 'a'])
    await admin.query('UPDATE habittrove.family_configuration SET enabled=true')
    expect((await getAvatar(['legacy', 'old.png'])).status).toBe(200)
    selectedFamily = 'B'; expect((await getAvatar(['legacy', 'old.png'])).status).toBe(404)
    selectedFamily = 'A'
    await admin.query("UPDATE habittrove.users SET auth_version=1 WHERE id='dual'")
    expect((await getAvatar(['legacy', 'old.png'])).status).toBe(404)
  })
})
