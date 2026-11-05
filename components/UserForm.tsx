'use client';

import { useState } from 'react';
import { newPasswordSchema, usernameSchema } from '@/lib/zod';
import { useTranslations } from 'next-intl';
import { Input } from './ui/input';
import { Button } from './ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Permission, PublicUser } from '@/lib/types';
import { toast } from '@/hooks/use-toast';
import { useAtom, useAtomValue } from 'jotai';
import { serverSettingsAtom, usersAtom, currentUserAtom } from '@/lib/atoms';
import { createUser, updateUser, updateUserPassword, uploadAvatar, loadUsersPublicData } from '@/app/actions/data';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { User as UserIcon } from 'lucide-react';
import _ from 'lodash';
import { PermissionSelector } from './PermissionSelector';


interface UserFormProps {
  userId?: string;  // if provided, we're editing; if not, we're creating
  account?: PublicUser;
  onCancel: () => void;
  onSuccess: () => void | Promise<void>;
}

export default function UserForm({ userId, account, onCancel, onSuccess }: UserFormProps) {
  const t = useTranslations('UserForm');
  const accountText = useTranslations('AccountSecurity');
  const [users, setUsersData] = useAtom(usersAtom);
  const serverSettings = useAtomValue(serverSettingsAtom)
  const user = userId ? account?.id === userId ? account : users.currentUser?.id === userId ? users.currentUser : users.users.find(u => u.id === userId) : undefined;
  const [currentUser] = useAtom(currentUserAtom)
  const canEditLegacyPermissions = !!currentUser?.isAdmin && !serverSettings.familiesEnabled
  const getDefaultPermissions = (): Permission[] => [{
    habit: {
      write: true,
      interact: true
    },
    wishlist: {
      write: true,
      interact: true
    },
    coins: {
      write: true,
      interact: true
    }
  }];

  const [avatarPath, setAvatarPath] = useState(user?.avatarPath)
  const [username, setUsername] = useState(user?.username || '');
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState<string | undefined>('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [oidcSubject, setOidcSubject] = useState('');
  const [removeOidc, setRemoveOidc] = useState(false);
  const [disablePassword, setDisablePassword] = useState(user ? !user.hasPassword : serverSettings.isDemo);
  const [error, setError] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin || false);
  const [permissions, setPermissions] = useState<Permission[]>(
    user?.permissions || getDefaultPermissions()
  );
  const [managedUserIds, setManagedUserIds] = useState<string[]>(user?.managedUserIds ?? [])
  const isEditing = !!user;

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const refreshFamilyDirectory = async () => {
    try { setUsersData(await loadUsersPublicData()) }
    catch { window.location.reload() }
  }

  const handleDeleteUser = async () => {
    if (!user) return;

    if (serverSettings.isDemo) {
      toast({
        title: t('errorTitle'),
        description: t('toastDemoDeleteDisabled'),
        variant: 'destructive',
      });
      return;
    }

    if (currentUser && currentUser.id === user.id) {
      toast({
        title: t('errorTitle'),
        description: t('toastCannotDeleteSelf'),
        variant: 'destructive',
      });
      return;
    }

    setIsDeleting(true);
    try {
      const response = await fetch('/api/user/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });

      if (response.ok) {
        if (serverSettings.familiesEnabled) await refreshFamilyDirectory()
        else setUsersData(prev => ({
          ...prev,
          users: prev.users.filter(u => u.id !== user.id),
        }));
        toast({
          title: t('toastUserDeletedTitle'),
          description: t('toastUserDeletedDescription', { username: user.username }),
          variant: 'default'
        });
        await onSuccess();
      } else {
        const errorData = await response.json();
        toast({
          title: t('errorTitle'),
          description: errorData.error || t('genericError'),
          variant: 'destructive',
        });
      }
    } catch (error) {
      toast({
        title: t('errorTitle'),
        description: t('networkError'),
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      // Validate username
      const usernameResult = usernameSchema.safeParse(username);
      if (!usernameResult.success) {
        setError(usernameResult.error.issues[0].message);
        return;
      }

      // Validate password unless disabled
      if (!disablePassword && password) {
        const passwordResult = newPasswordSchema.safeParse(password);
        if (!passwordResult.success) {
          setError(passwordResult.error.issues[0].message);
          return;
        }
      }

      if (isEditing) {
        const profileChanged = username !== user.username || email !== (user.email || '') || avatarPath !== user.avatarPath ||
          (currentUser?.isAdmin && (isAdmin !== user.isAdmin || oidcSubject || removeOidc)) ||
          (canEditLegacyPermissions && (!_.isEqual(permissions, user.permissions) || !_.isEqual(managedUserIds, user.managedUserIds ?? [])));
        const passwordChanged = (disablePassword && user.hasPassword) || !!password;
        if (profileChanged && passwordChanged) {
          setError(accountText('saveSeparately'));
          return;
        }
        // Update existing user
        if (profileChanged) {
          await updateUser(user.id, {
            username,
            ...(email !== (user.email || '') && { email }),
            avatarPath,
            ...(canEditLegacyPermissions && !_.isEqual(permissions, user.permissions) && { permissions }),
            ...(currentUser?.isAdmin && isAdmin !== user.isAdmin && { isAdmin }),
            ...(currentUser?.isAdmin && oidcSubject && { oidcSubject }),
            ...(currentUser?.isAdmin && removeOidc && { oidcSubject: null }),
            ...(canEditLegacyPermissions && !_.isEqual(managedUserIds, user.managedUserIds ?? []) && { managedUserIds }),
          });
        }

        // Handle password update
        if (disablePassword && user.hasPassword) {
          await updateUserPassword(user.id, undefined, currentPassword);
        } else if (password) {
          await updateUserPassword(user.id, password, currentPassword);
        }

        if (!serverSettings.familiesEnabled) setUsersData(prev => {
          const updateAccount = (account: PublicUser): PublicUser => ({
              ...account,
              username,
              email,
              avatarPath,
              ...(currentUser?.isAdmin && { isAdmin }),
              ...(canEditLegacyPermissions && { permissions, managedUserIds }),
              hasPassword: disablePassword ? false : (password ? true : !!account.hasPassword),
              hasOidc: removeOidc ? false : (oidcSubject ? true : !!account.hasOidc),
          })
          return {
            ...prev,
            ...(prev.currentUser?.id === user.id && { currentUser: updateAccount(prev.currentUser) }),
            users: prev.users.map(account => account.id === user.id ? updateAccount(account) : account),
          }
        });

        toast({
          title: t('toastUserUpdatedTitle'),
          description: t('toastUserUpdatedDescription', { username }),
          variant: 'default'
        });
      } else {
        // Create new user
        const formData = new FormData();
        formData.append('username', username);
        formData.append('email', email);
        if (disablePassword) {
          formData.append('password', '');
        } else if (password) {
          formData.append('password', password);
        }
        if (!serverSettings.familiesEnabled) formData.append('permissions', JSON.stringify(isAdmin ? undefined : permissions));
        if (currentUser?.isAdmin) formData.append('isAdmin', JSON.stringify(isAdmin));
        formData.append('avatarPath', avatarPath || '');
        if (oidcSubject) formData.append('oidcSubject', oidcSubject);

        const newUser = await createUser(formData);
        if (!serverSettings.familiesEnabled) setUsersData(prev => ({
          ...prev,
          users: [...prev.users, newUser]
        }));

        toast({
          title: t('toastUserCreatedTitle'),
          description: t('toastUserCreatedDescription', { username }),
          variant: 'default'
        });
      }

      if (serverSettings.familiesEnabled) await refreshFamilyDirectory()
      setPassword('');
      setError('');
      await onSuccess();
      if (user && currentUser?.id === user.id &&
          (email !== (user.email || '') || !!password || (disablePassword && user.hasPassword) ||
           oidcSubject || removeOidc || isAdmin !== user.isAdmin || !_.isEqual(permissions, user.permissions))) {
        window.location.reload();
      }
    } catch (err) {
      const action = isEditing ? t('actionUpdate') : t('actionCreate');
      setError(err instanceof Error ? err.message : t('errorFailedUserAction', { action }));
    }
  };

  const handleAvatarChange = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) { // 5MB
      toast({
        title: t('errorTitle'),
        description: t('errorFileSizeLimit'),
        variant: 'destructive'
      });
      return;
    }

    const formData = new FormData();
    formData.append('avatar', file);

    try {
      const path = await uploadAvatar(formData);
      setAvatarPath(path);
      setAvatarFile(null); // Clear the file since we've uploaded it
      toast({
        title: t('toastAvatarUploadedTitle'),
        description: t('toastAvatarUploadedDescription'),
        variant: 'default'
      });
    } catch (err) {
      toast({
        title: t('errorTitle'),
        description: t('errorFailedAvatarUpload'),
        variant: 'destructive'
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-h-[80vh] overflow-y-auto p-4">
      <div className="flex flex-col items-center gap-4 p-4 bg-muted/50 rounded-lg">
        <Avatar className="h-24 w-24">
          <AvatarImage
            src={avatarPath && `/api/avatars/${avatarPath.split('/').pop()}`}
            alt={username}
          />
          <AvatarFallback>
            <UserIcon className="h-12 w-12" />
          </AvatarFallback>
        </Avatar>
        <div>
          <input
            type="file"
            id="avatar"
            name="avatar"
            accept="image/png, image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleAvatarChange(file);
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const input = document.getElementById('avatar') as HTMLInputElement;
              input.value = ''; // Reset input to allow selecting same file again
              input.click();
            }}
            className="w-full"
          >
            {isEditing ? t('changeAvatarButton') : t('uploadAvatarButton')}
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="username">{t('usernameLabel')}</Label>
          <Input
            id="username"
            type="text"
            placeholder={t('usernamePlaceholder')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={error ? 'border-red-500' : ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="account-email">{accountText('emailLabel')}</Label>
          <Input id="account-email" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required />
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">
              {isEditing ? t('newPasswordLabel') : t('passwordLabel')}
            </Label>
            <Input
              id="password"
              type="password"
              placeholder={isEditing ? t('passwordPlaceholderEdit') : t('passwordPlaceholderCreate')}
              value={password || ''}
              onChange={(e) => setPassword(e.target.value)}
              className={error ? 'border-red-500' : ''}
              disabled={disablePassword}
            />
            {serverSettings.isDemo && (
              <p className="text-sm text-red-500">{t('demoPasswordDisabledMessage')}</p>
            )}
            {isEditing && currentUser?.id === user?.id && !user.hasPassword && !serverSettings.isDemo && (
              <p className="text-sm text-muted-foreground">{accountText('initialPasswordAdmin')}</p>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <Switch
              id="disable-password"
              checked={disablePassword}
              onCheckedChange={setDisablePassword}
              disabled={serverSettings.isDemo || (!currentUser?.isAdmin && !!user)}
            />
            <Label htmlFor="disable-password">{t('disablePasswordLabel')}</Label>
          </div>
          {isEditing && currentUser?.id === user?.id && user?.hasPassword && (password || (disablePassword && user.hasPassword)) && (
            <div className="space-y-2">
              <Label htmlFor="current-password">{accountText('currentPassword')}</Label>
              <Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required />
            </div>
          )}
        </div>

        {currentUser?.isAdmin && (
          <div className="space-y-2">
            <Label htmlFor="oidc-subject">{accountText('oidcSubject')}</Label>
            <Input id="oidc-subject" value={oidcSubject} onChange={event => setOidcSubject(event.target.value)} placeholder={user?.hasOidc ? accountText('subjectReplacePlaceholder') : accountText('subjectPlaceholder')} autoComplete="off" />
            {user?.hasOidc && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={removeOidc} onChange={event => setRemoveOidc(event.target.checked)} />
                {accountText('removeOidcLink')}
              </label>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-red-500 bg-red-50 dark:bg-red-950/50 p-2 rounded">{error}</p>
        )}


        {currentUser?.isAdmin && serverSettings.familiesEnabled && <div className="space-y-2 rounded border p-3">
          <div className="flex items-center justify-between gap-3"><Label htmlFor="site-administrator">{accountText('siteAdministrator')}</Label>
            <Switch id="site-administrator" checked={isAdmin} onCheckedChange={setIsAdmin} /></div>
          <p className="text-sm text-muted-foreground">{accountText('siteAdministratorDescription')}</p>
        </div>}
        {canEditLegacyPermissions && <PermissionSelector
          permissions={permissions}
          isAdmin={isAdmin}
          onPermissionsChange={setPermissions}
          onAdminChange={setIsAdmin}
        />}
        {canEditLegacyPermissions && isEditing && <fieldset className="space-y-2 rounded border p-3">
          <legend className="px-1 font-medium">{t('managedFamilyMembers')}</legend>
          <p className="text-sm text-muted-foreground">{t('managedFamilyHelp')}</p>
          {users.users.filter(candidate => candidate.id !== user.id).map(candidate => <label key={candidate.id} className="flex items-center gap-2">
            <input type="checkbox" checked={managedUserIds.includes(candidate.id)} onChange={event =>
              setManagedUserIds(previous => event.target.checked ? [...previous, candidate.id] : previous.filter(id => id !== candidate.id))} />
            {candidate.username}
          </label>)}
        </fieldset>}

      </div>

      <div className="flex justify-end gap-2 pt-2">
        {isEditing && (
          <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                className="mr-auto bg-red-700 text-white hover:bg-red-800"
                disabled={serverSettings.isDemo || isDeleting}
              >
                {isDeleting ? t('deletingButtonText') : t('deleteAccountButton')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('areYouSure')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('deleteUserConfirmation', { username: user.username })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isDeleting}>{t('cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDeleteUser}
                  disabled={isDeleting}
                  className="bg-red-700 text-white hover:bg-red-800"
                >
                  {isDeleting ? t('deletingButtonText') : t('confirmDeleteButtonText')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
        >
          {t('cancelButton')}
        </Button>
        <Button type="submit" disabled={!username}>
          {isEditing ? t('saveChangesButton') : t('createUserButton')}
        </Button>
      </div>
    </form>
  );
}
