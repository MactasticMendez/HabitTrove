'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { loadFamilyState, selectFamily } from '@/app/actions/family'
import type { FamilyState } from '@/lib/family-types'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import Link from 'next/link'

export default function FamilySelector() {
  const t = useTranslations('FamilyMembership')
  const [state, setState] = useState<FamilyState | null>(null)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    loadFamilyState().then(value => { if (active) setState(value) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [])

  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">{t('loadError')}</p>
  if (!state?.familiesEnabled) return null
  if (!state.families.length) return <Link href="/family" className="rounded-md border px-3 py-2 text-sm underline underline-offset-4">{t('noFamilyEntry')}</Link>

  const change = async (familyId: string) => {
    if (switching || familyId === state.selectedFamilyId) return
    setSwitching(true)
    try { await selectFamily(familyId) } finally {
      // A full reload also discards in-flight responses and all previous family atoms.
      window.location.reload()
    }
  }

  return <div className="min-w-0 space-y-1">
    <Label htmlFor="active-family">{t('selectedFamily')}</Label>
    <select id="active-family" value={state.selectedFamilyId ?? ''} disabled={switching}
      className="h-10 w-full min-w-0 max-w-64 rounded-md border border-input bg-background px-3 text-sm"
      onChange={event => { void change(event.target.value).catch(() => {}) }}>
      {!state.selectedFamilyId && <option value="" disabled>{t('chooseFamily')}</option>}
      {state.families.map(family => <option key={family.id} value={family.id}>{family.name}</option>)}
    </select>
    <Dialog open={switching}>
      <DialogContent className="w-[calc(100vw_-_2rem)] max-w-sm [&>button]:hidden" onEscapeKeyDown={event => event.preventDefault()}
        onPointerDownOutside={event => event.preventDefault()}>
        <DialogTitle>{t('switching')}</DialogTitle>
        <DialogDescription role="status">{t('switchingDescription')}</DialogDescription>
      </DialogContent>
    </Dialog>
  </div>
}
