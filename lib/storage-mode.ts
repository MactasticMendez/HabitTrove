export function usesPostgres(): boolean {
  const mode = process.env.HABITTROVE_STORAGE
  if (mode && mode !== 'postgres' && mode !== 'legacy-json') throw new Error('Invalid storage selection')
  if (mode === 'legacy-json') {
    if (process.env.NODE_ENV === 'production' && process.env.DEMO !== 'true') {
      throw new Error('Legacy JSON storage is limited to development, tests and demo installations')
    }
    return false
  }
  if (process.env.DATABASE_URL) return true
  if (mode === 'postgres') throw new Error('DATABASE_URL is required for PostgreSQL storage')
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' || process.env.DEMO === 'true' ||
      process.env.NEXT_PHASE === 'phase-production-build') return false
  throw new Error('DATABASE_URL is required; run the database migration before starting HabitTrove')
}
