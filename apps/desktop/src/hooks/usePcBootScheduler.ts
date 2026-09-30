import { useEffect, useRef } from 'react'
import { bridgeApi } from '@/api/bridge'
import { useAppStore } from '@/stores/appStore'
import {
  appendPcBootLog,
  claimDuePcBootJobs,
} from '@/devices/pc-boot/pcBootLocal'

/**
 * Runs hipc local timer/countdown while the app is open (any page).
 */
export function usePcBootScheduler() {
    const dataSource = useAppStore((s) => s.dataSource)
  const showToast = useAppStore((s) => s.showToast)
  const patchDevicePreview = useAppStore((s) => s.patchDevicePreview)
  const rememberCapabilities = useAppStore((s) => s.rememberCapabilities)
  const refreshDeviceCapabilities = useAppStore((s) => s.refreshDeviceCapabilities)
  const running = useRef(false)

  useEffect(() => {
    const tick = async () => {
      if (running.current) return
      const jobs = claimDuePcBootJobs()
      if (!jobs.length) return
      running.current = true
      try {
        for (const job of jobs) {
          const nextOn = job.action === 'on'
          try {
            if (dataSource === 'live') {
              await bridgeApi.setProp(job.deviceId, 'on', nextOn)
              window.setTimeout(() => {
                void refreshDeviceCapabilities(job.deviceId)
              }, 800)
            }
            const caps = useAppStore.getState().capabilityCache[job.deviceId]?.caps
            if (caps) {
              rememberCapabilities(job.deviceId, {
                ...caps,
                values: { ...caps.values, on: nextOn, status: nextOn ? 1 : 0 },
              })
            }
            patchDevicePreview(job.deviceId, { power: nextOn })
            appendPcBootLog(job.deviceId, job.logKey)
            showToast("动作已执行")
            window.dispatchEvent(
              new CustomEvent('pc-boot-local-changed', { detail: { deviceId: job.deviceId } }),
            )
          } catch (err) {
            showToast(err instanceof Error ? err.message : "同步失败")
          }
        }
      } finally {
        running.current = false
      }
    }

    const id = window.setInterval(() => {
      void tick()
    }, 1000)
    void tick()
    return () => window.clearInterval(id)
  }, [
    dataSource,
    showToast,
    patchDevicePreview,
    rememberCapabilities,
    refreshDeviceCapabilities,
  ])
}
