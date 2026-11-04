import fs from 'fs/promises'
import path from 'path'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/server-helpers'
import type { HabitsData, HabitCompletionRecord } from '@/lib/types'

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
    const data = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'habits.json'), 'utf8')) as HabitsData
    let permittedRecord: HabitCompletionRecord | undefined
    for (const habit of data.habits) {
      const record = habit.completionRecords?.find(item => item?.evidenceId === id)
      if (record && !record.voided && (record.actorId === user.id || habit.createdBy === user.id ||
          habit.approverIds?.includes(user.id))) {
        permittedRecord = record
        break
      }
    }
    const mime = permittedRecord?.evidenceMime
    if (!mime || !(mime in extensions)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const evidenceDir = path.resolve(process.cwd(), 'data', 'evidence')
    const filePath = path.resolve(evidenceDir, `${id}.${extensions[mime]}`)
    const stats = await fs.lstat(filePath)
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 2_000_000) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const realDir = await fs.realpath(evidenceDir)
    const realFile = await fs.realpath(filePath)
    if (!realFile.startsWith(`${realDir}${path.sep}`)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return new NextResponse(await fs.readFile(realFile), {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `inline; filename="evidence.${extensions[mime]}"`,
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
