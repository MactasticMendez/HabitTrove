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
})
await copyFile('lib/db/schema.sql', 'dist/schema.sql')
