import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import fs from 'fs/promises'
import path from 'path'
import { ALLOWED_AVATAR_EXTENSIONS, AVATAR_CONTENT_TYPE } from '@/lib/avatar'
import { getCurrentUser } from '@/lib/server-helpers'
import { log } from '@/lib/logger'
import { usesPostgres } from '@/lib/storage-mode'
import { currentDatabaseClient } from '@/lib/db/client'
import { getFamiliesEnabled, withFamilyScope, withFreshFamilyActor } from '@/lib/family-scope'

function sanitizePathSegments(pathSegments?: string[]): string[] | null {
  if (!pathSegments || pathSegments.length === 0) {
    return null
  }

  const safeSegments: string[] = []

  for (const rawSegment of pathSegments) {
    let segment = rawSegment

    try {
      segment = decodeURIComponent(rawSegment)
    } catch {
      return null
    }

    if (!segment || segment === '.' || segment === '..') {
      return null
    }

    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      return null
    }

    safeSegments.push(segment)
  }

  return safeSegments
}

function isPathInsideBase(basePath: string, targetPath: string): boolean {
  return targetPath === basePath || targetPath.startsWith(`${basePath}${path.sep}`)
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null
  }

  const { code } = error as { code?: unknown }
  return typeof code === 'string' ? code : null
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { path: pathSegments } = await Promise.resolve(params)
  const safeSegments = sanitizePathSegments(pathSegments)

  if (!safeSegments) {
    return NextResponse.json({ error: 'Invalid avatar path' }, { status: 400 })
  }

  const avatarsDir = path.resolve(process.cwd(), 'data', 'avatars')
  const filePath = path.resolve(avatarsDir, ...safeSegments)

  if (!isPathInsideBase(avatarsDir, filePath)) {
    return NextResponse.json({ error: 'Invalid avatar path' }, { status: 400 })
  }

  const ext = path.extname(filePath).toLowerCase()

  if (!ALLOWED_AVATAR_EXTENSIONS.has(ext)) {
    return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
  }

  try {
    const serve = async (expectedHash?: string) => {
      let directory = path.dirname(avatarsDir)
      for (const segment of ['', 'avatars', ...safeSegments.slice(0, -1)]) {
        directory = path.join(directory, segment)
        const stats = await fs.lstat(directory)
        if (stats.isSymbolicLink() || !stats.isDirectory()) return NextResponse.json({ error: 'Invalid avatar path' }, { status: 400 })
      }
      const realAvatarsDir = await fs.realpath(avatarsDir)
      const fileStats = await fs.lstat(filePath)

      if (fileStats.isSymbolicLink()) {
        return NextResponse.json({ error: 'Invalid avatar path' }, { status: 400 })
      }

      const realFilePath = await fs.realpath(filePath)

      if (!isPathInsideBase(realAvatarsDir, realFilePath)) {
        return NextResponse.json({ error: 'Invalid avatar path' }, { status: 400 })
      }

      const file = await fs.readFile(realFilePath)
      if (expectedHash) {
        const { createHash } = await import('node:crypto')
        if (createHash('sha256').update(file).digest('hex') !== expectedHash) return NextResponse.json({ error: 'File not found' }, { status: 404 })
      }

      return new NextResponse(file, {
        headers: {
          'Content-Type': AVATAR_CONTENT_TYPE[ext] ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      })
    }
    if (!usesPostgres() || !await getFamiliesEnabled()) return await serve()
    const authorize = async (memberIds: string[]) => {
      const client = currentDatabaseClient()!
      const relativePath = `avatars/${safeSegments.join('/')}`
      const metadata = (await client.query('SELECT owner_id,sha256,inaccessible FROM attachments WHERE path=$1', [relativePath])).rows
      if (metadata.length) {
        const attachment = metadata.find(row => !row.inaccessible && /^[a-f0-9]{64}$/.test(row.sha256 ?? '') && memberIds.includes(row.owner_id))
        return attachment ? serve(attachment.sha256) : NextResponse.json({ error: 'File not found' }, { status: 404 })
      }
      // Old installations may reference a nested avatar path before attachment metadata existed.
      const referenced = await client.query("SELECT id FROM users WHERE id=ANY($1::text[]) AND attributes->'fields'->>'avatarPath'=$2 LIMIT 1", [memberIds, `/data/${relativePath}`])
      return referenced.rowCount ? serve() : NextResponse.json({ error: 'File not found' }, { status: 404 })
    }
    const familyId = (await cookies()).get('habittrove-family')?.value
    if (familyId) return await withFamilyScope(user, async scope => scope ? authorize(scope.memberIds) : NextResponse.json({ error: 'File not found' }, { status: 404 }), familyId, { readOnly: true })
    return await withFreshFamilyActor(user, async () => {
      const memberships = await currentDatabaseClient()!.query('SELECT 1 FROM family_memberships WHERE user_id=$1 AND active LIMIT 1', [user.id])
      return memberships.rowCount ? NextResponse.json({ error: 'File not found' }, { status: 404 }) : authorize([user.id])
    }, { readOnly: true })
  } catch (error) {
    if (error instanceof Error && ['Unauthorized', 'Family access denied', 'Invalid family'].includes(error.message)) return NextResponse.json({ error: 'File not found' }, { status: 404 })
    if (getErrorCode(error) === 'ENOENT') {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      )
    }

    log('error', 'Error reading avatar file', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
