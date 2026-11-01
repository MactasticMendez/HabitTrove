import { describe, expect, mock, test } from 'bun:test'

let deletedUserId: string | undefined
mock.module('@/auth', () => ({ auth: async () => ({ user: { id: 'member' } }) }))
mock.module('@/lib/server-helpers', () => ({ getCurrentUser: async () => ({ id: 'member', isAdmin: false }) }))
mock.module('@/app/actions/data', () => ({ deleteUser: async (id: string) => { deletedUserId = id } }))

const { POST } = await import('./route')

function request(origin: string, contentType = 'application/json') {
  return new Request('https://habit.example/api/user/delete', {
    method: 'POST',
    headers: { origin, 'content-type': contentType },
    body: JSON.stringify({ userId: 'member' }),
  })
}

describe('POST /api/user/delete', () => {
  test('rejects cross-origin deletion', async () => {
    deletedUserId = undefined
    const response = await POST(request('https://attacker.example'))
    expect(response.status).toBe(403)
    expect(deletedUserId).toBeUndefined()
  })

  test('rejects form-compatible content types', async () => {
    deletedUserId = undefined
    const response = await POST(request('https://habit.example', 'text/plain'))
    expect(response.status).toBe(415)
    expect(deletedUserId).toBeUndefined()
  })

  test('accepts a same-origin JSON self-deletion request', async () => {
    deletedUserId = undefined
    const response = await POST(request('https://habit.example'))
    expect(response.status).toBe(200)
    expect(String(deletedUserId)).toBe('member')
  })
})
