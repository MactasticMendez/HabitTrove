import fs from 'fs/promises'
import path from 'path'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getCurrentUser } from '@/lib/server-helpers'
import type { HabitsData, HabitCompletionRecord } from '@/lib/types'
import { usesPostgres } from '@/lib/storage-mode'
import { currentDatabaseClient, withStorageTransaction } from '@/lib/db/client'
import { getFamiliesEnabled, withFamilyScope } from '@/lib/family-scope'

const extensions = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser()
  if (!user?.email && process.env.DEMO !== 'true') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const familiesEnabled = usesPostgres() && await getFamiliesEnabled()
    const serve = async (selectedFamilyId?: string) => {
      if (familiesEnabled && !selectedFamilyId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      let permittedRecord: HabitCompletionRecord | undefined
      let expectedHash: string | undefined
      if (usesPostgres()) {
        const result = await currentDatabaseClient()!.query(`SELECT a.path,a.mime_type,a.sha256 FROM attachments a
          JOIN completions c ON c.habit_id=a.habit_id AND c.id=a.completion_id AND c.evidence_id=a.id
          JOIN habits h ON h.id=c.habit_id
          WHERE a.id=$1 AND NOT COALESCE(c.voided,false) AND c.evidence_mime=a.mime_type
          AND (c.actor_id=$2 OR h.created_by=$2 OR EXISTS(SELECT 1 FROM habit_approvers p WHERE p.habit_id=h.id AND p.user_id=$2 ${familiesEnabled ? 'AND p.family_id=$3' : ''}))
          ${familiesEnabled ? 'AND NOT a.inaccessible AND a.family_id=$3 AND c.family_id=$3 AND h.family_id=$3' : ''}`,
        familiesEnabled ? [id, user.id, selectedFamilyId] : [id, user.id])
        const attachment = result.rows[0]
        if (attachment && /^[a-f0-9]{64}$/.test(attachment.sha256 ?? '') && attachment.mime_type in extensions && attachment.path === `evidence/${id}.${extensions[attachment.mime_type as keyof typeof extensions]}`) {
          permittedRecord = { id, actorId: user.id, evidenceId: id, evidenceMime: attachment.mime_type }
          expectedHash = attachment.sha256
        }
      } else {
        const data = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'habits.json'), 'utf8')) as HabitsData
        for (const habit of data.habits) {
          const record = habit.completionRecords?.find(item => item?.evidenceId === id)
          if (record && !record.voided && (record.actorId === user.id || habit.createdBy === user.id ||
              habit.approverIds?.includes(user.id))) {
            permittedRecord = record
            break
          }
      }
      }
      const mime = permittedRecord?.evidenceMime
      if (!mime || !(mime in extensions)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const evidenceDir = path.resolve(process.cwd(), 'data', 'evidence')
      const filePath = path.resolve(evidenceDir, `${id}.${extensions[mime]}`)
      for (const directory of [path.dirname(evidenceDir), evidenceDir]) {
        const stats = await fs.lstat(directory)
        if (stats.isSymbolicLink() || !stats.isDirectory()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      const stats = await fs.lstat(filePath)
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 2_000_000) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      const realDir = await fs.realpath(evidenceDir)
      const realFile = await fs.realpath(filePath)
      if (!realFile.startsWith(`${realDir}${path.sep}`)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const bytes = await fs.readFile(realFile)
      if (expectedHash) {
        const { createHash } = await import('node:crypto')
        if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      return new NextResponse(bytes, {
        headers: {
          'Content-Type': mime,
          'Content-Disposition': `inline; filename="evidence.${extensions[mime]}"`,
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    if (!usesPostgres()) return await serve()
    if (!familiesEnabled) return await withStorageTransaction(serve, { readOnly: true })
    const familyId = (await cookies()).get('habittrove-family')?.value
    return await withFamilyScope(user, async (scope) => scope ? serve(scope.familyId) : NextResponse.json({ error: 'Not found' }, { status: 404 }), familyId, { readOnly: true })
  } catch (error) {
    if (error instanceof Error && ['Unauthorized', 'Family access denied', 'Invalid family'].includes(error.message)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
