import { afterEach, expect, test } from 'bun:test'
import { usesPostgres } from './storage-mode'

const original = { ...process.env }
afterEach(() => { process.env = { ...original } })

test('a configured database is authoritative even in development', () => {
  Object.assign(process.env, { NODE_ENV: 'development' })
  process.env.DATABASE_URL = 'postgresql://localhost/habittrove'
  delete process.env.HABITTROVE_STORAGE
  expect(usesPostgres()).toBe(true)
})

test('production cannot silently fall back to legacy files', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  delete process.env.NEXT_PHASE
  delete process.env.DATABASE_URL
  delete process.env.HABITTROVE_STORAGE
  delete process.env.DEMO
  expect(() => usesPostgres()).toThrow('DATABASE_URL')
  process.env.HABITTROVE_STORAGE = 'legacy-json'
  expect(() => usesPostgres()).toThrow('Legacy JSON')
})

test('legacy fixtures remain explicit and an invalid selection fails', () => {
  Object.assign(process.env, { NODE_ENV: 'test' })
  delete process.env.DATABASE_URL
  process.env.HABITTROVE_STORAGE = 'legacy-json'
  expect(usesPostgres()).toBe(false)
  process.env.HABITTROVE_STORAGE = 'postgres'
  expect(() => usesPostgres()).toThrow('DATABASE_URL')
  process.env.HABITTROVE_STORAGE = 'unknown'
  expect(() => usesPostgres()).toThrow('Invalid storage')
})
