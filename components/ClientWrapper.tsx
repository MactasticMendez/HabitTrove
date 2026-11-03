'use client'

import { ReactNode, useEffect, useCallback, useState, Suspense } from 'react'
import { useAtom, useSetAtom, useAtomValue } from 'jotai'
import { aboutOpenAtom, pomodoroAtom, userSelectAtom, currentUserIdAtom, clientFreshnessTokenAtom, usersAtom, serverSettingsAtom } from '@/lib/atoms'
import PomodoroTimer from './PomodoroTimer'
import UserSelectModal, { AnonymousSignIn } from './UserSelectModal'
import { useSession } from 'next-auth/react'
import AboutModal from './AboutModal'
import LoadingSpinner from './LoadingSpinner'
import { checkDataFreshness as checkServerDataFreshness } from '@/app/actions/data'
import RefreshBanner from './RefreshBanner'
import CompleteEmailAccount from './CompleteEmailAccount'

function ClientWrapperContent({ children }: { children: ReactNode }) {
  const [pomo] = useAtom(pomodoroAtom)
  const [userSelect, setUserSelect] = useAtom(userSelectAtom)
  const [aboutOpen, setAboutOpen] = useAtom(aboutOpenAtom)
  const setCurrentUserIdAtom = useSetAtom(currentUserIdAtom)
  const { data: session, status } = useSession()
  const currentUserId = session?.user.id
  const users = useAtomValue(usersAtom)
  const serverSettings = useAtomValue(serverSettingsAtom)
  const currentAccount = users.users.find(user => user.id === currentUserId)
  const [showRefreshBanner, setShowRefreshBanner] = useState(false);

  // clientFreshnessTokenAtom is async, useAtomValue will suspend until it's resolved.
  // Suspense boundary is in app/layout.tsx or could be added here if needed more locally.
  const clientToken = useAtomValue(clientFreshnessTokenAtom);


  useEffect(() => {
    setCurrentUserIdAtom(currentUserId)
  }, [currentUserId, setCurrentUserIdAtom])

  const performFreshnessCheck = useCallback(async () => {
    if (!clientToken || status !== 'authenticated' || (!currentAccount?.email && !serverSettings.isDemo)) return;

    try {
      const result = await checkServerDataFreshness(clientToken);
      if (!result.isFresh) {
        setShowRefreshBanner(true);
      }
    } catch (error) {
      console.error("Failed to check data freshness with server:", error);
    }
  }, [clientToken, status, currentAccount?.email, serverSettings.isDemo]);

  useEffect(() => {
    // Interval for polling data freshness
    if (clientToken && !showRefreshBanner && status === 'authenticated') {
      const intervalId = setInterval(() => {
        performFreshnessCheck();
      }, 30000); // Check every 30 seconds

      return () => clearInterval(intervalId);
    }
  }, [clientToken, performFreshnessCheck, showRefreshBanner, status]);

  const handleRefresh = () => {
    setShowRefreshBanner(false);
    window.location.reload();
  };

  return (
    status === 'loading'
      ? <LoadingSpinner />
      : status === 'unauthenticated'
      ? <main className="min-h-screen flex items-center justify-center bg-background p-4">
          <div className="w-full max-w-md space-y-5 rounded-lg border bg-card p-6">
            <h1 className="text-2xl font-semibold">HabitTrove</h1>
            <AnonymousSignIn onSuccess={() => {}} authentikEnabled={serverSettings.authentikEnabled} oidcDisplayName={serverSettings.oidcDisplayName} isDemo={serverSettings.isDemo} />
          </div>
        </main>
      : status === 'authenticated' && currentAccount && !currentAccount.email && !serverSettings.isDemo
      ? <CompleteEmailAccount userId={currentAccount.id} username={currentAccount.username} />
      :
    <>
      {children}
      {pomo.show && <PomodoroTimer />}
      {userSelect && <UserSelectModal onClose={() => setUserSelect(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {showRefreshBanner && <RefreshBanner onRefresh={handleRefresh} />}
    </>
  );
}

export default function ClientWrapper({ children }: { children: ReactNode }) {
  const [isMounted, setIsMounted] = useState(false);

  // block client-side hydration until mounted (this is crucial to wait for all jotai atoms to load),
  // to prevent SSR hydration errors in the children components
  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return <LoadingSpinner />;
  }

  return (
    <Suspense fallback={<LoadingSpinner />}>
      <ClientWrapperContent>{children}</ClientWrapperContent>
    </Suspense>
  );
}
