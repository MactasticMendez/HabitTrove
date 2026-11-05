export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.NEXT_PHASE === 'phase-production-build') return
    const { init, validateRuntimeStorage } = await import('./lib/env.server')
    init()
    await validateRuntimeStorage()
    const { initializeAdminConfiguration } = await import('./lib/admin-config')
    await initializeAdminConfiguration()
    const { initializeScheduler } = await import('./lib/scheduler')
    initializeScheduler()
  }
}
