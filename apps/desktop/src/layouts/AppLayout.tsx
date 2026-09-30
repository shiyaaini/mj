import { useEffect } from 'react'
import { Outlet, Navigate } from 'react-router-dom'
import { ScrollToTop } from '@/components/ScrollToTop'
import { Sidebar } from '@/components/Sidebar'
import { DeviceDetailDialog } from '@/pages/DeviceDetailPage'
import { useAppStore } from '@/stores/appStore'

export function AppLayout() {
  const authenticated = useAppStore((s) => s.authenticated)
  const dataSource = useAppStore((s) => s.dataSource)
  const syncing = useAppStore((s) => s.syncing)
  const syncFromBridge = useAppStore((s) => s.syncFromBridge)

  useEffect(() => {
    if (authenticated && dataSource === 'live') {
      void syncFromBridge()
    }
  }, [authenticated, dataSource, syncFromBridge])

  if (!authenticated) return <Navigate to="/login" replace />

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-pane">
        {syncing ? <div className="sync-banner">正在同步米家数据…</div> : null}
        <Outlet />
        <ScrollToTop />
      </main>
      <DeviceDetailDialog />
    </div>
  )
}
