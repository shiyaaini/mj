import { useEffect, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { bridgeApi } from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { useAppStore } from '@/stores/appStore'
import { DetailPowerButton } from '@/devices/shared/DetailPowerButton'
import '@/devices/shared/detail.css'

interface Props {
  device: Device
}

const BRIGHT_MAX = 65535
const CT_MIN = 2700
const CT_MAX = 6500

function uiToBright(ui: number, deviceMax: number) {
  if (deviceMax <= 100) return ui
  return Math.round(1 + ((ui - 1) / 99) * (BRIGHT_MAX - 1))
}

export function LightDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cached = useAppStore((s) => s.deviceCache[device.id])
  const rememberDeviceState = useAppStore((s) => s.rememberDeviceState)
  const refreshDeviceSnapshot = useAppStore((s) => s.refreshDeviceSnapshot)
  const showToast = useAppStore((s) => s.showToast)

  const [power, setPower] = useState(Boolean(device.preview?.power))
  const [brightness, setBrightness] = useState(Number(device.preview?.brightness ?? 60))
  const [ct, setCt] = useState(Number(device.preview?.colorTemp ?? 4000))
  const [switchName, setSwitchName] = useState('on')
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const hasCache = Boolean(cached)

  useEffect(() => {
    if (!hydrated || !cached) return
    if (cached.power !== undefined) setPower(Boolean(cached.power))
    if (cached.brightness !== undefined) setBrightness(Number(cached.brightness))
    if (cached.colorTemp !== undefined) setCt(Number(cached.colorTemp))
    if (cached.switchName) setSwitchName(cached.switchName)
  }, [hydrated, cached])

  useEffect(() => {
    if (!hydrated || dataSource !== 'live') return
    let cancelled = false
    const load = async () => {
      const hadCache = Boolean(useAppStore.getState().deviceCache[device.id])
      if (!hadCache) setSyncing(true)
      try {
        await refreshDeviceSnapshot(device.id)
      } finally {
        if (!cancelled) setSyncing(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [hydrated, dataSource, device.id, refreshDeviceSnapshot])

  const togglePower = async () => {
    const next = !power
    setPower(next)
    rememberDeviceState(device.id, { power: next, switchName })
    if (dataSource !== 'live') return
    setBusy('power')
    try {
      if (switchName) await bridgeApi.setProp(device.id, switchName, next)
      else await bridgeApi.setSwitch(device.id, next)
    } catch (err) {
      setPower(!next)
      rememberDeviceState(device.id, { power: !next })
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const commitBrightness = async (ui: number) => {
    rememberDeviceState(device.id, { brightness: ui })
    if (dataSource !== 'live') return
    setBusy('brightness')
    try {
      await bridgeApi.setProp(device.id, 'brightness', uiToBright(ui, BRIGHT_MAX))
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const commitCt = async (value: number) => {
    rememberDeviceState(device.id, { colorTemp: value })
    if (dataSource !== 'live') return
    setBusy('ct')
    try {
      await bridgeApi.setProp(device.id, 'color-temperature', value)
    } catch {
      try {
        await bridgeApi.setProp(device.id, 'color_temperature', value)
      } catch (inner) {
        showToast(inner instanceof Error ? inner.message : "同步失败")
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="detail-layout">
      <section className="panel hero-panel template-hero">
        <div className="detail-power-wrap">
          <DetailPowerButton
            on={power}
            label={power ? "已开启" : "已关闭"}
            busy={busy === 'power'}
            onClick={() => void togglePower()}
          />
        </div>
        {syncing ? (
          <p className="meta soft">正在同步…</p>
        ) : hasCache ? (
          <p className="meta soft">已显示上次状态</p>
        ) : null}
      </section>

      <section className="panel adjust-panel">
        <h2>调节</h2>
        <div className="adjust-list">
          <div className="adjust-card">
            <div className="adjust-head">
              <span>亮度</span>
              <strong>{brightness}%</strong>
            </div>
            <input
              className="adjust-slider"
              type="range"
              min={1}
              max={100}
              step={1}
              value={brightness}
              disabled={busy === 'brightness'}
              style={{
                background: `linear-gradient(90deg, var(--accent) ${brightness}%, #e6ebf2 ${brightness}%)`,
              }}
              onChange={(e) => setBrightness(Number(e.target.value))}
              onMouseUp={(e) => void commitBrightness(Number((e.target as HTMLInputElement).value))}
              onTouchEnd={(e) =>
                void commitBrightness(Number((e.target as HTMLInputElement).value))
              }
            />
            <div className="adjust-scale">
              <span>1%</span>
              <span>100%</span>
            </div>
          </div>

          <div className="adjust-card">
            <div className="adjust-head">
              <span>色温</span>
              <strong>{ct}K</strong>
            </div>
            <input
              className="adjust-slider"
              type="range"
              min={CT_MIN}
              max={CT_MAX}
              step={50}
              value={ct}
              disabled={busy === 'ct'}
              style={{
                background: `linear-gradient(90deg, #f2c57c 0%, #fff6e8 50%, #9ec9ff 100%)`,
              }}
              onChange={(e) => setCt(Number(e.target.value))}
              onMouseUp={(e) => void commitCt(Number((e.target as HTMLInputElement).value))}
              onTouchEnd={(e) => void commitCt(Number((e.target as HTMLInputElement).value))}
            />
            <div className="adjust-scale">
              <span>{CT_MIN}K</span>
              <span>{CT_MAX}K</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
