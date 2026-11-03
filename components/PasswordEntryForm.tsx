'use client';

import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { User as UserIcon } from 'lucide-react';
import { SafeUser } from '@/lib/types';
import { toast } from '@/hooks/use-toast';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { signInWithAuthentik } from '@/app/actions/user';
import { useAtomValue } from 'jotai';
import { serverSettingsAtom } from '@/lib/atoms';

interface PasswordEntryFormProps {
  user: SafeUser;
  onCancel: () => void;
  onSubmit: (password: string) => Promise<void>;
  error?: string;
}

export default function PasswordEntryForm({ 
  user, 
  onCancel, 
  onSubmit,
  error 
}: PasswordEntryFormProps) {
  const t = useTranslations('PasswordEntryForm');
  const accountText = useTranslations('AccountSecurity');
  const hasPassword = user.hasPassword ?? false;
  const serverSettings = useAtomValue(serverSettingsAtom);
  const canUseLocal = hasPassword || serverSettings.isDemo;
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await onSubmit(password);
    } catch (err) {
      toast({
        title: t('loginErrorToastTitle'),
        description: err instanceof Error ? err.message : t('loginFailedErrorToastDescription'),
        variant: "destructive"
      });
    }
  };

  return (
    <div className="space-y-4">
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex flex-col items-center gap-4 p-4 bg-muted/50 rounded-lg">
        <Avatar className="h-24 w-24">
          <AvatarImage 
            src={user.avatarPath && `/api/avatars/${user.avatarPath.split('/').pop()}`} 
          />
          <AvatarFallback>
            <UserIcon className="h-12 w-12" />
          </AvatarFallback>
        </Avatar>
        <div className="text-center">
          <div className="font-medium text-lg">
            {user.username}
          </div>
          <button 
            type="button"
            onClick={onCancel}
            className="text-sm text-blue-500 hover:text-blue-600 mt-1"
          >
            {t('notYouButton')}
          </button>
        </div>
      </div>

      {hasPassword && <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">{t('passwordLabel')}</Label>
          <Input
            id="password"
            type="password"
            placeholder={t('passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={error ? 'border-red-500' : ''}
          />
          {error && (
            <p className="text-sm text-red-500 bg-red-50 dark:bg-red-950/50 p-2 rounded">{error}</p>
          )}
        </div>
      </div>}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancelButton')}
        </Button>
        <Button type="submit" disabled={!canUseLocal || (hasPassword && !password)}>
          {t('loginButton')}
        </Button>
      </div>
    </form>
    {user.hasAuthentik && serverSettings.authentikEnabled && (
      <form action={signInWithAuthentik}>
        <Button type="submit" variant="outline" className="w-full">{accountText('continueAuthentik', { name: serverSettings.oidcDisplayName })}</Button>
      </form>
    )}
    {!canUseLocal && !(user.hasAuthentik && serverSettings.authentikEnabled) && (
      <p role="status" className="text-sm text-destructive">{accountText('contactAdmin')}</p>
    )}
    </div>
  );
}
