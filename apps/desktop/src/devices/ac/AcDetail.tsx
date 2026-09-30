import { useEffect, useMemo, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { bridgeApi, type DeviceCapabilities } from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { AC_MODE_LABELS, pickLabel } from '@/labels'
import { useAppStore } from '@/stores/appStore'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import { DetailPowerButton } from '@/devices/shared/DetailPowerButton'
import '@/devices/shared/detail.css'
import './ac.css'

const AC_TEMPLATE_PROPS = [
  'ir-mode',
  'ir-temperature',
  'fan-speed-down',
  'fan-speed-up',
  'temperature-down',
  'temperature-up',
  'turn-off',
  'turn-on',
]

/** Spec ir-mode value_list */
const MODES = [
  { value: 0, key: 'auto' as const },
  { value: 1, key: 'cool' as const },
  { value: 2, key: 'dry' as const },
  { value: 3, key: 'heat' as const },
  { value: 4, key: 'fan' as const },
]

interface Props {
  device: Device
}

export function AcDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cachedEntry = useAppStore((s) => s.capabilityCache[device.id])
  const rememberCapabilities = useAppStore((s) => s.rememberCapabilities)
  const refreshDeviceCapabilities = useAppStore((s) => s.refreshDeviceCapabilities)
  const showToast = useAppStore((s) => s.showToast)

  const [caps, setCaps] = useState<DeviceCapabilities | null>(null)
  /** IR props are write-only — UI keeps optimistic local state */
  const [powerOn, setPowerOn] = useState(true)
  const [mode, setMode] = useState(1)
  const [temp, setTemp] = useState(26)
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const tempRange = useMemo(() => {
    const prop = caps?.properties?.find((p) => p.name === 'ir-temperature')
    const r = prop?.range
    if (Array.isArray(r) && r.length >= 2) {
      return {
        min: Number(r[0]) || 16,
        max: Number(r[1]) || 30,
        step: Number(r[2]) || 1,
      }
    }
    return { min: 16, max: 30, step: 1 }
  }, [caps])

  useEffect(() => {
    if (!hydrated) return
    if (!cachedEntry?.caps) return
    setCaps(cachedEntry.caps)
    const v = cachedEntry.caps.values || {}
    if (typeof v['ir-mode'] === 'number') setMode(Number(v['ir-mode']))
    if (typeof v['ir-temperature'] === 'number') setTemp(Number(v['ir-temperature']))
    if (typeof v._power === 'boolean') setPowerOn(Boolean(v._power))
  }, [hydrated, cachedEntry])

  useEffect(() => {
    if (!hydrated) return
    if (dataSource !== 'live') {
      setPowerOn(true)
      setMode(1)
      setTemp(26)
      return
    }
    let cancelled = false
    const load = async () => {
      const hadCache = Boolean(useAppStore.getState().capabilityCache[device.id])
      if (hadCache) setSyncing(true)
      try {
        await refreshDeviceCapabilities(device.id)
      } finally {
        if (!cancelled) setSyncing(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [hydrated, dataSource, device.id, refreshDeviceCapabilities])

  const persistLocal = (patch: Record<string, unknown>) => {
    const base = caps || cachedEntry?.caps
    if (!base) return
    const nextValues = { ...(base.values || {}), ...patch }
    rememberCapabilities(device.id, { ...base, values: nextValues })
  }

  const setPropValue = async (name: string, value: unknown) => {
    persistLocal({ [name]: value })
    if (dataSource !== 'live') return
    setBusy(name)
    try {
      await bridgeApi.setProp(device.id, name, value)
      showToast("动作已执行")
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const runAction = async (name: string) => {
    setBusy(name)
    try {
      if (dataSource === 'live') {
        await bridgeApi.runDeviceAction(device.id, name)
      }
      if (name === 'turn-on') {
        setPowerOn(true)
        persistLocal({ _power: true })
      }
      if (name === 'turn-off') {
        setPowerOn(false)
        persistLocal({ _power: false })
      }
      showToast("动作已执行")
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const selectMode = async (next: number) => {
    setMode(next)
    await setPropValue('ir-mode', next)
  }

  const commitTemp = async (next: number) => {
    const clamped = Math.min(
      tempRange.max,
      Math.max(tempRange.min, Math.round(next / tempRange.step) * tempRange.step),
    )
    setTemp(clamped)
    await setPropValue('ir-temperature', clamped)
  }

  const nudgeTemp = async (delta: number) => {
    const next = temp + delta * tempRange.step
    if (next < tempRange.min || next > tempRange.max) return
    await commitTemp(next)
  }

  const tempPct =
    ((temp - tempRange.min) / (tempRange.max - tempRange.min || 1)) * 100

  const currentMode = MODES.find((m) => m.value === mode) ?? MODES[1]

  return (
    <div className="detail-layout ac-layout">
      <section className="panel hero-panel template-hero ac-hero">
        <div className="ac-hero-top">
          <div className={`ac-icon tone-${currentMode.key}`} aria-hidden>
            {modeIcon(currentMode.key)}
          </div>
          <div>
            <p className={`ac-hero-mode tone-${currentMode.key}`}>
              {pickLabel(AC_MODE_LABELS, currentMode.key)}
              {powerOn ? ` · ${temp}°C` : ''}
            </p>
            <p className="meta soft">红外遥控：状态不可回读，界面为本次发送的设定</p>
          </div>
        </div>

        <div className="detail-power-row">
          <DetailPowerButton
            on={powerOn}
            size="md"
            label="开启"
            busy={busy === 'turn-on'}
            onClick={() => void runAction('turn-on')}
          />
          <DetailPowerButton
            on={!powerOn}
            size="md"
            label="关闭"
            busy={busy === 'turn-off'}
            onClick={() => void runAction('turn-off')}
          />
        </div>

        {syncing ? <p className="meta soft">正在同步…</p> : null}
      </section>

      <section className={`panel plug-card-panel${powerOn ? '' : ' ac-dimmed'}`}>
        <h2>模式</h2>
        <div className="ac-mode-row">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`ac-mode-chip${mode === m.value ? ' active' : ''}${mode === m.value ? ` tone-${m.key}` : ''}`}
              disabled={!!busy || !powerOn}
              onClick={() => void selectMode(m.value)}
            >
              <i aria-hidden>{modeIcon(m.key)}</i>
              <span>{pickLabel(AC_MODE_LABELS, m.key)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={`panel plug-card-panel${powerOn ? '' : ' ac-dimmed'}`}>
        <div className="plug-card-head row">
          <strong>温度</strong>
          <span className="ac-temp-value">
            {temp}
            <small>°C</small>
          </span>
        </div>
        <div className="ac-temp-controls">
          <button
            type="button"
            className="ac-step-btn"
            disabled={!!busy || !powerOn || temp <= tempRange.min}
            onClick={() => void nudgeTemp(-1)}
            aria-label="降温"
          >
            −
          </button>
          <input
            className="ac-slider"
            type="range"
            min={tempRange.min}
            max={tempRange.max}
            step={tempRange.step}
            value={temp}
            disabled={busy === 'ir-temperature' || !powerOn}
            style={{
              background: `linear-gradient(90deg, var(--accent) ${tempPct}%, var(--switch-track) ${tempPct}%)`,
            }}
            onChange={(e) => setTemp(Number(e.target.value))}
            onMouseUp={(e) => void commitTemp(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) =>
              void commitTemp(Number((e.target as HTMLInputElement).value))
            }
          />
          <button
            type="button"
            className="ac-step-btn"
            disabled={!!busy || !powerOn || temp >= tempRange.max}
            onClick={() => void nudgeTemp(1)}
            aria-label="升温"
          >
            +
          </button>
        </div>
        <p className="meta soft">
          {tempRange.min}–{tempRange.max}°C
        </p>
      </section>

      <section className={`panel plug-card-panel${powerOn ? '' : ' ac-dimmed'}`}>
        <h2>风速</h2>
        <p className="meta soft">通过红外加减风速，无法读取当前档位</p>
        <div className="ac-fan-row">
          <button
            type="button"
            className="btn btn-ghost ac-fan-btn"
            disabled={!!busy || !powerOn}
            onClick={() => void runAction('fan-speed-down')}
          >
            风速 −
          </button>
          <button
            type="button"
            className="btn btn-ghost ac-fan-btn"
            disabled={!!busy || !powerOn}
            onClick={() => void runAction('fan-speed-up')}
          >
            风速 +
          </button>
        </div>
      </section>

      <DeviceCapabilityPanel
        device={device}
        asSupplement
        excludeNames={AC_TEMPLATE_PROPS}
      />
    </div>
  )
}

function modeIcon(key: (typeof MODES)[number]['key']): string {
  switch (key) {
    case 'auto':
      return 'Ⓐ'
    case 'cool':
      return '❄'
    case 'dry':
      return '💧'
    case 'heat':
      return '♨'
    case 'fan':
      return '✵'
    default:
      return '·'
  }
}
