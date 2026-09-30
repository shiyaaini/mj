import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { resetBridgeUnauthorizedGuard, setBridgeUnauthorizedHandler } from '@/api/bridge'
import { TitleBar } from '@/components/TitleBar'
import { AppLayout } from '@/layouts/AppLayout'
import { LoginPage } from '@/pages/LoginPage'
import { HomePage } from '@/pages/HomePage'
import { DevicesPage } from '@/pages/DevicesPage'
import { DeviceDetailRedirect } from '@/pages/DeviceDetailRedirect'
import { ScenesPage } from '@/pages/ScenesPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { TemplatesPage } from '@/pages/TemplatesPage'
import { usePcBootScheduler } from '@/hooks/usePcBootScheduler'
import { useAppStore } from '@/stores/appStore'

export default function App() {
  usePcBootScheduler()
  const toast = useAppStore((s) => s.toast)

  useEffect(() => {
    setBridgeUnauthorizedHandler(() => {
      const { authenticated, dataSource, logout, showToast } = useAppStore.getState()
      if (!authenticated || dataSource !== 'live') return
      logout()
      showToast('登录已过期，请重新登录')
    })
    return () => setBridgeUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    const unsub = useAppStore.subscribe((s, prev) => {
      if (s.authenticated && s.dataSource === 'live' && (!prev.authenticated || prev.dataSource !== 'live')) {
        resetBridgeUnauthorizedGuard()
      }
    })
    return unsub
  }, [])

  return (
    <div className="app-root">
      <TitleBar />
      <div className="app-body">
        <HashRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<AppLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/devices" element={<DevicesPage />} />
              <Route path="/devices/:id" element={<DeviceDetailRedirect />} />
              <Route path="/scenes" element={<ScenesPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
