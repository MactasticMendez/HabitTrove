'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DynamicTimeNoSSR } from '@/components/DynamicTimeNoSSR';
import { useAtom } from 'jotai';
import { useTranslations } from 'next-intl';
import { settingsAtom, serverSettingsAtom, currentUserAtom, browserSettingsAtom } from '@/lib/atoms';
import { Settings, WeekDay } from '@/lib/types'
import { saveSettings } from '../actions/data'
import { Info } from 'lucide-react';
import { toast } from '@/hooks/use-toast'
import { useState, type KeyboardEvent } from 'react'
import AdminConfiguration from '@/components/AdminConfiguration'
import StatusDaysSettings from '@/components/StatusDaysSettings'
import FamilyInvites from '@/components/FamilyInvites'

export default function SettingsPage() {
  const t = useTranslations('SettingsPage');
  const [settings, setSettings] = useAtom(settingsAtom);
  const [browserSettings, setBrowserSettings] = useAtom(browserSettingsAtom);
  const [serverSettings] = useAtom(serverSettingsAtom);
  const [currentUser] = useAtom(currentUserAtom);
  const [activeTab, setActiveTab] = useState<'preferences' | 'admin'>('preferences');

  const updateSettings = async (newSettings: Settings) => {
    await saveSettings(newSettings)
    setSettings(newSettings)
  }

  const changeTabWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!currentUser?.isAdmin || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'preferences' : event.key === 'End' ? 'admin' :
      activeTab === 'preferences' ? 'admin' : 'preferences'
    setActiveTab(next)
    document.getElementById(`settings-tab-${next}`)?.focus()
  }

  if (!settings) return null

  return (
    <>
      <div>
        <h1 className="text-3xl font-bold mb-6">{t('title')}</h1>
        <div role="tablist" aria-label={t('sectionsLabel')} className="mb-6 flex gap-2 border-b border-border">
          <button
            id="settings-tab-preferences"
            type="button"
            role="tab"
            aria-controls="settings-panel-preferences"
            aria-selected={activeTab === 'preferences' || !currentUser?.isAdmin}
            tabIndex={activeTab === 'preferences' || !currentUser?.isAdmin ? 0 : -1}
            onClick={() => setActiveTab('preferences')}
            onKeyDown={changeTabWithKeyboard}
            className={`rounded-t-md px-4 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${activeTab === 'preferences' || !currentUser?.isAdmin ? 'border-b-2 border-primary font-semibold' : 'text-foreground/80'}`}
          >{t('preferencesTab')}</button>
          {currentUser?.isAdmin && <button
            id="settings-tab-admin"
            type="button"
            role="tab"
            aria-controls="settings-panel-admin"
            aria-selected={activeTab === 'admin'}
            tabIndex={activeTab === 'admin' ? 0 : -1}
            onClick={() => setActiveTab('admin')}
            onKeyDown={changeTabWithKeyboard}
            className={`rounded-t-md px-4 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${activeTab === 'admin' ? 'border-b-2 border-primary font-semibold' : 'text-foreground/80'}`}
          >{t('adminTab')}</button>}
        </div>
        <div id="settings-panel-preferences" role="tabpanel" aria-labelledby="settings-tab-preferences" tabIndex={0} hidden={activeTab === 'admin' && !!currentUser?.isAdmin}>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>{t('uiSettingsTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div><Label htmlFor="reminders-enabled">{t('remindersEnabled')}</Label>
                <p className="text-sm text-muted-foreground">{t('remindersHelp')}</p></div>
              <Switch id="reminders-enabled" checked={Boolean(browserSettings.remindersEnabled)}
                onCheckedChange={checked => setBrowserSettings(previous => ({ ...previous, remindersEnabled: checked }))} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="reminder-lead">{t('reminderLead')}</Label>
              <select id="reminder-lead" className="rounded-md border bg-background px-3 py-2"
                value={browserSettings.reminderLeadMinutes ?? 0}
                onChange={event => setBrowserSettings(previous => ({ ...previous, reminderLeadMinutes: Number(event.target.value) }))}>
                <option value={0}>{t('reminderAtTime')}</option>
                <option value={5}>{t('reminderMinutes', { count: 5 })}</option>
                <option value={10}>{t('reminderMinutes', { count: 10 })}</option>
                <option value={30}>{t('reminderMinutes', { count: 30 })}</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="number-formatting">{t('numberFormattingLabel')}</Label>
                <div className="text-sm text-muted-foreground">
                  {t('numberFormattingDescription')}
                </div>
              </div>
              <Switch
                id="number-formatting"
                className="min-h-6"
                checked={settings.ui.useNumberFormatting}
                onCheckedChange={(checked) =>
                  updateSettings({
                    ...settings,
                    ui: { ...settings.ui, useNumberFormatting: checked }
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="number-grouping">{t('numberGroupingLabel')}</Label>
                <div className="text-sm text-muted-foreground">
                  {t('numberGroupingDescription')}
                </div>
              </div>
              <Switch
                id="number-grouping"
                className="min-h-6"
                checked={settings.ui.useGrouping}
                onCheckedChange={(checked) =>
                  updateSettings({
                    ...settings,
                    ui: { ...settings.ui, useGrouping: checked }
                  })
                }
              />
            </div>
          </CardContent>
        </Card>
        <StatusDaysSettings />
        </div>

        {currentUser?.isAdmin && <div id="settings-panel-admin" role="tabpanel" aria-labelledby="settings-tab-admin" tabIndex={0} hidden={activeTab !== 'admin'}>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>{t('systemSettingsTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="timezone">{t('timezoneLabel')}</Label>
                <div className="text-sm text-muted-foreground">
                  {t('timezoneDescription')}
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <select
                  id="timezone"
                  value={settings.system.timezone}
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      system: { ...settings.system, timezone: e.target.value }
                    })
                  }
                  className="w-[110px] xs:w-[200px] rounded-md border border-input bg-background px-3 py-2 mb-4"
                >
                  {Intl.supportedValuesOf('timeZone').map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
                <DynamicTimeNoSSR />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="weekStartDay">{t('weekStartDayLabel')}</Label>
                <div className="text-sm text-muted-foreground">
                  {t('weekStartDayDescription')}
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <select
                  id="weekStartDay"
                  value={settings.system.weekStartDay}
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      system: { ...settings.system, weekStartDay: Number(e.target.value) as WeekDay }
                    })
                  }
                  className="w-[110px] xs:w-[200px] rounded-md border border-input bg-background px-3 py-2"
                >
                  {([
                    ['sunday', 0],
                    ['monday', 1],
                    ['tuesday', 2],
                    ['wednesday', 3],
                    ['thursday', 4],
                    ['friday', 5],
                    ['saturday', 6]
                  ] as Array<["sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday", WeekDay]>).map(([dayName, dayNumber]) => (
                    <option key={dayNumber} value={dayNumber}>
                      {t(`weekdays.${dayName}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="auto-backup">{t('autoBackupLabel')}</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" aria-label={t('autoBackupTooltip')} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                          <Info aria-hidden="true" className="h-4 w-4 text-muted-foreground cursor-help" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" align="start">
                        <p className="max-w-xs text-sm">
                          {t('autoBackupTooltip')}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <div className="text-sm text-muted-foreground">
                  {t('autoBackupDescription')}
                </div>
              </div>
              <Switch
                id="auto-backup"
                className="min-h-6"
                checked={settings.system.autoBackupEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({
                    ...settings,
                    system: { ...settings.system, autoBackupEnabled: checked }
                  })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="language-select">{t('languageLabel')}</Label>
                </div>
                <div className="text-sm text-muted-foreground">
                  {t('languageDescription')}
                </div>
                {serverSettings.isDemo && (
                  <div className="text-sm text-red-500">
                    {t('languageDisabledInDemoTooltip')}
                  </div>
                )}
              </div>
              <select
                id="language-select"
                value={settings.system.language}
                disabled={serverSettings.isDemo}
                onChange={(e) => {
                  updateSettings({
                    ...settings,
                    system: { ...settings.system, language: e.target.value }
                  });
                  toast({
                    title: t('languageChangedTitle'),
                    description: t('languageChangedDescription'),
                    variant: 'default',
                  });
                }}
                className={`w-[110px] xs:w-[200px] rounded-md border border-input bg-background px-3 py-2 ${serverSettings.isDemo ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <option value="en">English</option>
                <option value="es">Español</option>
                <option value="ca">Català</option>
                <option value="de">Deutsch</option>
                <option value="fr">Français</option>
                <option value="ru">Русский</option>
                <option value="zh">简体中文</option>
                <option value="ko">한국어</option>
                <option value="ja">日本語</option>
              </select>
            </div>

          </CardContent>
        </Card>
        <AdminConfiguration />
        <FamilyInvites />
        </div>}

      </div >
    </>
  )
}
