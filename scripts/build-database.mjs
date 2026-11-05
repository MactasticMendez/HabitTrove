import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
await build({
  entryPoints: ['scripts/database.ts', 'scripts/database-recovery.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  logLevel: 'warning',
  // These entry points execute only in Node; Next's compile-time server marker has no runtime package.
  plugins: [{
    name: 'offline-server-only-marker',
    setup(builder) {
      builder.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'offline-server-only' }))
      builder.onLoad({ filter: /.*/, namespace: 'offline-server-only' }, () => ({ contents: 'export {}', loader: 'js' }))
    },
  }],
})
await copyFile('lib/db/schema.sql', 'dist/schema.sql')

await mkdir('dist/db', { recursive: true })
await copyFile('lib/db/family-schema.sql', 'dist/db/family-schema.sql')
