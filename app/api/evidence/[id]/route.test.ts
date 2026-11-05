import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { User } from '@/lib/types'

let currentUser: User | undefined
mock.module('@/lib/server-helpers', () => ({ getCurrentUser: async () => currentUser }))
mock.module('server-only', () => ({}))
const { GET } = await import('./route')
const evidenceId = '11111111-1111-4111-8111-111111111111'
let directory: string
let cwdSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-evidence-'))
  cwdSpy = spyOn(process, 'cwd').mockReturnValue(directory)
  await fs.mkdir(path.join(directory, 'data', 'evidence'), { recursive: true })
  await fs.writeFile(path.join(directory, 'data', 'habits.json'), JSON.stringify({ habits: [{
    id: 'task', name: 'Chore', userIds: ['member'], approverIds: ['approver'],
    completions: [new Date().toISOString()],
    completionRecords: [{ id: evidenceId, actorId: 'member', approval: 'pending',
      evidenceId, evidenceMime: 'image/png' }],
  }] }))
  await fs.writeFile(path.join(directory, 'data', 'evidence', `${evidenceId}.png`), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  currentUser = { id: 'approver', username: 'approver', email: 'approver@example.com' }
})

afterEach(async () => {
  cwdSpy.mockRestore()
  currentUser = undefined
  await fs.rm(directory, { recursive: true, force: true })
})

describe('completion evidence access', () => {
  test('serves evidence to a designated approver with private image headers', async () => {
    const response = await GET(new Request('http://localhost/api/evidence/' + evidenceId), { params: Promise.resolve({ id: evidenceId }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('hides evidence from unrelated and signed-out users', async () => {
    currentUser = { id: 'assigned', username: 'assigned', email: 'assigned@example.com' }
    const habits = JSON.parse(await fs.readFile(path.join(directory, 'data', 'habits.json'), 'utf8'))
    habits.habits[0].userIds.push('assigned')
    await fs.writeFile(path.join(directory, 'data', 'habits.json'), JSON.stringify(habits))
    expect((await GET(new Request('http://localhost/api/evidence/' + evidenceId), { params: Promise.resolve({ id: evidenceId }) })).status).toBe(404)
    currentUser = { id: 'stranger', username: 'stranger', email: 'stranger@example.com' }
    expect((await GET(new Request('http://localhost/api/evidence/' + evidenceId), { params: Promise.resolve({ id: evidenceId }) })).status).toBe(404)
    currentUser = undefined
    expect((await GET(new Request('http://localhost/api/evidence/' + evidenceId), { params: Promise.resolve({ id: evidenceId }) })).status).toBe(401)
  })

  test('rejects invalid IDs and symbolic links', async () => {
    expect((await GET(new Request('http://localhost/api/evidence/invalid'), { params: Promise.resolve({ id: '../auth.json' }) })).status).toBe(404)
    const filename = path.join(directory, 'data', 'evidence', `${evidenceId}.png`)
    await fs.unlink(filename)
    await fs.symlink(path.join(directory, 'data', 'habits.json'), filename)
    expect((await GET(new Request('http://localhost/api/evidence/' + evidenceId), { params: Promise.resolve({ id: evidenceId }) })).status).toBe(404)
  })

  test('rejects a symlinked evidence directory', async () => {
    const original = path.join(directory, 'data', 'evidence')
    const moved = path.join(directory, 'data', 'moved-evidence')
    await fs.rename(original, moved)
    await fs.symlink(moved, original)
    expect((await GET(new Request('http://localhost/api/evidence/' + evidenceId), { params: Promise.resolve({ id: evidenceId }) })).status).toBe(404)
  })
})

test('hides retained evidence for a voided completion even when the image file remains', async () => {
  const filename = path.join(directory, 'data', 'habits.json')
  const data = JSON.parse(await fs.readFile(filename, 'utf8'))
  data.habits[0].completionRecords[0].voided = true
  await fs.writeFile(filename, JSON.stringify(data))
  const response = await GET(new Request('http://localhost/api/evidence/' + evidenceId), { params: Promise.resolve({ id: evidenceId }) })
  expect(response.status).toBe(404)
})
