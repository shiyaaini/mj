import { useEffect, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { PURIFIER_MODE_LABELS, pickLabel } from '@/labels'
import { useAppStore } from '@/stores/appStore'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import { DetailPowerButton } from '@/devices/shared/DetailPowerButton'
import '@/devices/shared/detail.css'

const PURIFIER_TEMPLATE_PROPS = [
  'on',
  'mode',
  'pm2.5-density',
  'pm2_5_density',
  'pm25-density',
  'relative-humidity',
  'relative_humidity',
  'temperature',
  'filter-life-level',
  'filter_life_level',
]

interface Props {
  device: Device
}

export function PurifierDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cached = useAppStore((s) => s.deviceCache[device.id])
  const refreshDeviceSnapshot = useAppStore((s) => s.refreshDeviceSnapshot)
  const toggleDevicePower = useAppStore((s) => s.toggleDevicePower)
  const setPurifierMode = useAppStore((s) => s.setPurifierMode)

  const [syncing, setSyncing] = useState(false)

  const power = Boolean(cached?.power ?? device.preview?.power)
  const mode = String(cached?.mode ?? device.preview?.mode ?? 'auto')
  const pm25 = Number(cached?.pm25 ?? device.preview?.pm25 ?? device.preview?.pm2_5 ?? 12)
  const temperature = cached?.temperature ?? device.preview?.temperature
  const humidity =
    cached?.humidity ?? device.preview?.humidity ?? device.preview?.relative_humidity
  const filter = cached?.filter ?? device.preview?.filter_life_level
  const hasCache = Boolean(cached)

  useEffect(() => {
    if (!hydrated || dataSource !== 'live') return
    let cancelled = false
    const hadCache = Boolean(useAppStore.getState().deviceCache[device.id])
    if (!hadCache) setSyncing(true)
    void refreshDeviceSnapshot(device.id).finally(() => {
      if (!cancelled) setSyncing(false)
    })
    return () => {
      cancelled = true
    }
  }, [hydrated, dataSource, device.id, refreshDeviceSnapshot])

  return (
    <div className="detail-layout">
      <section className="panel hero-panel">
        {syncing ? (
          <p className="meta soft">正在同步…</p>
        ) : hasCache ? (
          <p className="meta soft">已显示上次状态</p>
        ) : null}
        <div className="detail-power-wrap">
          <DetailPowerButton
            on={power}
            label={power ? "已开启" : "已关闭"}
            onClick={() => void toggleDevicePower(device.id)}
          />
        </div>
        <div className="gauge">
          <div className="gauge-ring">
            <strong>{Number.isFinite(pm25) ? pm25 : '--'}</strong>
            <span>PM2.5</span>
            <em>优</em>
          </div>
        </div>
        <div className="metric-row">
          <div>
            <span>温度</span>
            <strong>{temperature !== undefined ? `${temperature}°C` : '--'}</strong>
          </div>
          <div>
            <span>湿度</span>
            <strong>{humidity !== undefined ? `${humidity}%` : '--'}</strong>
          </div>
          <div>
            <span>滤芯寿命</span>
            <strong>{filter !== undefined ? `${filter}%` : '--'}</strong>
          </div>
        </div>
        <div className="control-row">
          {(['auto', 'sleep', 'manual'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`mode-btn${mode === m ? ' active' : ''}`}
              onClick={() => void setPurifierMode(device.id, m)}
            >
              {pickLabel(PURIFIER_MODE_LABELS, m)}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>空气质量</h2>
        <div className="metrics-grid">
          {[
            ['PM2.5', String(Number.isFinite(pm25) ? pm25 : '--')],
            ['Temp', temperature !== undefined ? String(temperature) : '--'],
            ['Humidity', humidity !== undefined ? String(humidity) : '--'],
            ['Filter', filter !== undefined ? String(filter) : '--'],
            ['Mode', mode],
          ].map(([label, value]) => (
            <div key={label} className="metric-chip">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>

      <DeviceCapabilityPanel
        device={device}
        asSupplement
        excludeNames={PURIFIER_TEMPLATE_PROPS}
      />
    </div>
  )
}
