import { useState, useEffect } from 'react'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { usersAtom, currentUserAtom } from '@/lib/atoms'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { WishlistItemType } from '@/lib/types'
import EmojiPickerButton from './EmojiPickerButton'
import ModalOverlay from './ModalOverlay'
import DrawingModal from './DrawingModal'
import DrawingDisplay from './DrawingDisplay'
import { Brush } from 'lucide-react'
import { MAX_COIN_LIMIT } from '@/lib/constants'
import { checkPermission } from '@/lib/utils'

interface AddEditWishlistItemModalProps {
  isOpen: boolean
  setIsOpen: (isOpen: boolean) => void
  editingItem: WishlistItemType | null
  setEditingItem: (item: WishlistItemType | null) => void
  addWishlistItem: (item: Omit<WishlistItemType, 'id'>) => Promise<void>
  editWishlistItem: (item: WishlistItemType) => Promise<void>
  initialUserIds?: string[]
}

export default function AddEditWishlistItemModal({
  isOpen,
  setIsOpen,
  editingItem,
  setEditingItem,
  addWishlistItem,
  editWishlistItem,
  initialUserIds
}: AddEditWishlistItemModalProps) {
  const t = useTranslations('AddEditWishlistItemModal')
  const [name, setName] = useState(editingItem?.name || '')
  const [description, setDescription] = useState(editingItem?.description || '')
  const [coinCost, setCoinCost] = useState(editingItem?.coinCost || 1)
  const [targetCompletions, setTargetCompletions] = useState<number | undefined>(editingItem?.targetCompletions)
  const [link, setLink] = useState(editingItem?.link || '')
  const [currentUser] = useAtom(currentUserAtom)
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>((editingItem?.userIds ?? initialUserIds ?? []).filter(id => id !== currentUser?.id))
  const [includeSelf, setIncludeSelf] = useState(editingItem || initialUserIds
    ? !!(editingItem?.userIds ?? initialUserIds)?.includes(currentUser?.id ?? '') : true)
  const [saving, setSaving] = useState(false)
  const canAssignUser = (userId: string) => !!currentUser && (currentUser.isAdmin ||
    checkPermission(currentUser.permissions, 'wishlist', 'write') ||
    !!currentUser.managedUserIds?.includes(userId))
  const [errors, setErrors] = useState<{ [key: string]: string }>({})
  const [usersData] = useAtom(usersAtom)
  const [drawing, setDrawing] = useState<string>(editingItem?.drawing || '')
  const [isDrawingModalOpen, setIsDrawingModalOpen] = useState(false)

  useEffect(() => {
    if (editingItem) {
      setName(editingItem.name)
      setDescription(editingItem.description)
      setCoinCost(editingItem.coinCost)
      setTargetCompletions(editingItem.targetCompletions)
      setLink(editingItem.link || '')
      setDrawing(editingItem.drawing || '')
      setSelectedUserIds((editingItem.userIds || []).filter(id => id !== currentUser?.id))
      setIncludeSelf(!!editingItem.userIds?.includes(currentUser?.id ?? ''))
    } else {
      setName('')
      setDescription('')
      setCoinCost(1)
      setTargetCompletions(undefined)
      setLink('')
      setDrawing('')
      setSelectedUserIds((initialUserIds ?? []).filter(id => id !== currentUser?.id))
      setIncludeSelf(initialUserIds ? initialUserIds.includes(currentUser?.id ?? '') : true)
    }
    setErrors({})
  }, [editingItem, currentUser?.id, initialUserIds])

  const validate = () => {
    const newErrors: { [key: string]: string } = {}
    if (!name.trim()) {
      newErrors.name = t('errorNameRequired')
    }
    if (coinCost < 1) {
      newErrors.coinCost = t('errorCoinCostMin')
    } else if (coinCost > MAX_COIN_LIMIT) {
      newErrors.coinCost = t('errorCoinCostMax', { max: MAX_COIN_LIMIT })
    }
    if (targetCompletions !== undefined && targetCompletions < 1) {
      newErrors.targetCompletions = t('errorTargetCompletionsMin')
    }
    if (link && !isValidUrl(link)) {
      newErrors.link = t('errorInvalidUrl')
    }
    if (!includeSelf && selectedUserIds.length === 0) {
      newErrors.assignment = t('assignmentRequired')
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const isValidUrl = (url: string) => {
    try {
      const parsed = new URL(url)
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
    } catch {
      return false
    }
  }

  const handleClose = () => {
    setIsOpen(false)
    setEditingItem(null)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    const itemData = {
      name,
      description,
      coinCost,
      targetCompletions: targetCompletions || undefined,
      link: link.trim() || undefined,
      userIds: [...selectedUserIds, ...(includeSelf && currentUser ? [currentUser.id] : [])],
      drawing: drawing && drawing !== '[]' ? drawing : undefined
    }

    setSaving(true)
    try {
      if (editingItem) await editWishlistItem({ ...itemData, id: editingItem.id })
      else await addWishlistItem(itemData)
      setIsOpen(false)
      setEditingItem(null)
    } catch {
      setErrors(previous => ({ ...previous, save: t('saveError') }))
    } finally { setSaving(false) }
  }

  return (
    <>
      <ModalOverlay />
      <Dialog open={true} onOpenChange={(open) => {
        if (!open && !isDrawingModalOpen) {
          handleClose()
        }
      }} modal={false}>
        <DialogContent aria-describedby={undefined} className="max-h-[90dvh] w-[calc(100vw_-_2rem)] max-w-xl overflow-y-auto"> {/* DialogContent from shadcn/ui is typically z-50, ModalOverlay is z-40 */}
          <DialogHeader>
            <DialogTitle>{editingItem ? t('editTitle') : t('addTitle')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="min-w-0">
            <div className="flex min-w-0 flex-col gap-5 py-4">
              <div className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-4 sm:gap-4">
                <Label htmlFor="name" className="sm:text-right">
                  {t('nameLabel')}
                </Label>
                <div className="min-w-0 sm:col-span-3 flex gap-2">
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="min-w-0 flex-1"
                    required
                  />
                  <EmojiPickerButton
                    inputIdToFocus="name"
                    onEmojiSelect={(emoji) => {
                      setName(prev => {
                        const space = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
                        return `${prev}${space}${emoji}`;
                      })
                    }}
                  />
                </div>
              </div>
              <div className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-4 sm:gap-4">
                <Label htmlFor="description" className="sm:text-right">
                  {t('descriptionLabel')}
                </Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-w-0 sm:col-span-3"
                />
              </div>
              <div className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-4 sm:gap-4">
                <div className="flex items-center gap-2 sm:justify-end">
                  <Label htmlFor="coinReward">
                    {t('costLabel')}
                  </Label>
                </div>
                <div className="min-w-0 sm:col-span-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex shrink-0 items-center overflow-hidden rounded-lg border">
                      <button
                        type="button"
                        aria-label={t('decreaseCost')}
                        onClick={() => setCoinCost(prev => Math.max(0, prev - 1))}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
                      >
                        -
                      </button>
                      <Input
                        id="coinReward"
                        type="number"
                        value={coinCost}
                        onChange={(e) => {
                          const value = parseInt(e.target.value === "" ? "0" : e.target.value)
                          setCoinCost(Math.min(value, MAX_COIN_LIMIT))
                        }}
                        min={0}
                        max={MAX_COIN_LIMIT}
                        required
                        className="w-20 text-center border-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <button
                        type="button"
                        aria-label={t('increaseCost')}
                        onClick={() => setCoinCost(prev => Math.min(prev + 1, MAX_COIN_LIMIT))}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
                      >
                        +
                      </button>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t('coinsSuffix')}
                    </span>
                  </div>
                </div>
              </div>
              <div className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-4 sm:gap-4">
                <div className="flex items-center gap-2 sm:justify-end">
                  <Label htmlFor="targetCompletions">
                    {t('redeemableLabel')}
                  </Label>
                </div>
                <div className="min-w-0 sm:col-span-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex shrink-0 items-center overflow-hidden rounded-lg border">
                      <button
                        type="button"
                        aria-label={t('decreaseRedemptions')}
                        onClick={() => setTargetCompletions(prev => prev !== undefined && prev > 1 ? prev - 1 : undefined)}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
                      >
                        -
                      </button>
                      <Input
                        id="targetCompletions"
                        type="number"
                        value={targetCompletions || ''}
                        onChange={(e) => {
                          const value = e.target.value
                          setTargetCompletions(value && value !== "0" ? parseInt(value) : undefined)
                        }}
                        min={0}
                        placeholder="∞"
                        className="w-20 text-center border-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <button
                        type="button"
                        aria-label={t('increaseRedemptions')}
                        onClick={() => setTargetCompletions(prev => Math.min(10, (prev || 0) + 1))}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
                      >
                        +
                      </button>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t('timesSuffix')}
                    </span>
                  </div>
                  {errors.targetCompletions && (
                    <div className="text-sm text-red-500">
                      {errors.targetCompletions}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-4 sm:gap-4">
                <Label htmlFor="link" className="sm:text-right">
                  {t('linkLabel')}
                </Label>
                <div className="min-w-0 sm:col-span-3">
                  <Input
                    id="link"
                    type="url"
                    placeholder="https://..."
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    className="min-w-0 sm:col-span-3"
                  />
                  {errors.link && (
                    <div className="text-sm text-red-500">
                      {errors.link}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-4 sm:gap-4">
                <Label className="sm:text-right">
                  {t('drawingLabel')}
                </Label>
                <div className="min-w-0 sm:col-span-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setIsDrawingModalOpen(true)
                      }}
                      className="flex-1 justify-start"
                    >
                      <Brush className="h-4 w-4 mr-2" />
                      {drawing ? t('editDrawing') : t('addDrawing')}
                    </Button>
                    {drawing && (
                      <div className="flex-shrink-0">
                        <DrawingDisplay
                          drawingData={drawing}
                          width={80}
                          height={53}
                          className=""
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {(currentUser?.isAdmin || currentUser?.managedUserIds?.length) && <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={includeSelf} onChange={event => setIncludeSelf(event.target.checked)} />
                {t('includeSelf')}
              </label>}
              {usersData.users && usersData.users.length > 1 && (
                <div className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-4 sm:gap-4">
                  <div className="flex items-center gap-2 sm:justify-end">
                    <Label id="reward-sharing-label">{t('shareLabel')}</Label>
                  </div>
                  <div className="min-w-0 sm:col-span-3">
                    <div role="group" aria-labelledby="reward-sharing-label" className="flex flex-wrap gap-2">
                      {usersData.users.filter(user => user.id !== currentUser?.id && canAssignUser(user.id)).map(user => (
                        <button type="button" key={user.id} aria-label={t('assignUser', { username: user.username })}
                          aria-pressed={selectedUserIds.includes(user.id)}
                          className={`h-8 w-8 border-2 cursor-pointer
                          ${selectedUserIds.includes(user.id)
                              ? 'border-primary'
                              : 'border-muted'
                            }`}
                          onClick={() => {
                            setSelectedUserIds(prev =>
                              prev.includes(user.id)
                                ? prev.filter(id => id !== user.id)
                                : [...prev, user.id]
                            )
                          }}
                        >
                          <Avatar className="h-7 w-7">
                          <AvatarImage src={user?.avatarPath && `/api/avatars/${user.avatarPath.split('/').pop()}` || ""} />
                          <AvatarFallback>{user.username[0]}</AvatarFallback>
                          </Avatar>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {(errors.assignment || errors.save) && <p role="alert" className="text-sm text-destructive">{errors.assignment || errors.save}</p>}
            <DialogFooter>
              <Button type="submit" disabled={saving}>{editingItem ? t('saveButton') : t('addButton')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DrawingModal
        isOpen={isDrawingModalOpen}
        onClose={() => setIsDrawingModalOpen(false)}
        onSave={(drawingData) => setDrawing(drawingData)}
        initialDrawing={drawing}
        title={name}
      />
    </>
  )
}

