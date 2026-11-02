import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

let currentUser: { id: string } | undefined = { id: 'test-user' }
let directory: string
let cwdSpy: ReturnType<typeof spyOn>

mock.module('server-only', () => ({}))
mock.module('@/lib/server-helpers', () => ({ getCurrentUser: async () => currentUser }))

const { GET } = await import('./route')

const request = (segments: string[]) => GET(
  new Request('http://localhost:3000/api/avatars/' + segments.join('/')),
  { params: Promise.resolve({ path: segments }) },
)

beforeEach(async () => {
  currentUser = { id: 'test-user' }
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-avatar-route-'))
  await fs.mkdir(path.join(directory, 'data', 'avatars'), { recursive: true })
  cwdSpy = spyOn(process, 'cwd').mockReturnValue(directory)
})

afterEach(async () => {
  cwdSpy.mockRestore()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('GET /api/avatars/[...path]', () => {
  test('requires an authenticated user', async () => {
    currentUser = undefined
    expect((await request(['avatar.png'])).status).toBe(401)
  })

  test('returns an avatar with a safe content type', async () => {
    await fs.writeFile(path.join(directory, 'data', 'avatars', 'avatar.png'), 'avatar-binary')
    const response = await request(['avatar.png'])
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await response.text()).toBe('avatar-binary')
  })

  test('allows nested paths', async () => {
    const nested = path.join(directory, 'data', 'avatars', 'user-1')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, 'avatar.png'), 'avatar-binary')
    const response = await request(['user-1', 'avatar.png'])
    expect(response.status).toBe(200)
  })

  test('supports uppercase extensions', async () => {
    await fs.writeFile(path.join(directory, 'data', 'avatars', 'avatar.PNG'), 'avatar-binary')
    const response = await request(['avatar.PNG'])
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
  })

  for (const [name, segments] of [
    ['traversal segments', ['..', 'auth.json']],
    ['encoded traversal', ['%2e%2e%2fauth.json']],
    ['encoded backslash traversal', ['..%5cauth.png']],
    ['null bytes', ['avatar.png%00']],
    ['dot segments', ['.', 'avatar.png']],
    ['malformed encoding', ['%E0%A4%A']],
  ] as const) {
    test(`rejects ${name}`, async () => {
      const response = await request([...segments])
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid avatar path' })
    })
  }

  test('rejects unsupported file extensions', async () => {
    const response = await request(['config.json'])
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Unsupported file type' })
  })

  test('rejects symlinked avatar files', async () => {
    await fs.symlink(path.join(directory, 'data', 'auth.json'), path.join(directory, 'data', 'avatars', 'avatar.png'))
    const response = await request(['avatar.png'])
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid avatar path' })
  })

  test('rejects paths that resolve outside the avatar directory', async () => {
    const outside = path.join(directory, 'data', 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'avatar.png'), 'outside')
    await fs.symlink(outside, path.join(directory, 'data', 'avatars', 'escape'))
    const response = await request(['escape', 'avatar.png'])
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid avatar path' })
  })

  test('returns 404 when a file is missing', async () => {
    const response = await request(['missing.png'])
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'File not found' })
  })

  test('returns 500 for a non-ENOENT read error', async () => {
    await fs.mkdir(path.join(directory, 'data', 'avatars', 'avatar.png'))
    const response = await request(['avatar.png'])
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal server error' })
  })
})
