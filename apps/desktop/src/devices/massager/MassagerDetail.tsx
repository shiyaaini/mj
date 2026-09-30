import { useEffect, useMemo, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { bridgeApi, type DeviceCapabilities } from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import {
  MASSAGER_MODE_LABELS,
  MASSAGER_SPEED_LABELS,
  MASSAGER_STATE_LABELS,
  pickLabel,
} from '@/labels'
import { useAppStore } from '@/stores/appStore'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import { DetailPowerButton } from '@/devices/shared/DetailPowerButton'
import '@/devices/shared/detail.css'
import './massager.css'

const MASSAGER_TEMPLATE_PROPS = [
  'on',
  'mode',
  'heating',
  'battery-level',
  'device-state',
  'heat-switch-a',
  'direction-switch-a',
  'direction-interval-a',
  'speed-switch-a',
  'speed-interval-a',
  'working-time-a',
  'heat-switch-b',
  'direction-switch-b',
  'direction-interval-b',
  'speed-switch-b',
  'speed-interval-b',
  'working-time-b',
  'scene-mode-set-a',
  'scene-mode-set-b',
]

const MODES = [
  { value: 0, key: 'vitality' as const },
  { value: 1, key: 'knead' as const },
  { value: 2, key: 'unpack' as const },
]

interface Props {
  device: Device
}

function stateLabelKey(state: number): string {
  switch (state) {
    case 0:
      return 'vitality'
    case 1:
      return 'knead'
    case 2:
      return 'unpack'
    case 3:
      return 'scene'
    case 4:
      return 'standby'
    case 5:
      return 'charge'
    case 6:
      return 'shutdown'
    default:
      return 'unknown'
  }
}

export function MassagerDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cachedEntry = useAppStore((s) => s.capabilityCache[device.id])
  const rememberCapabilities = useAppStore((s) => s.rememberCapabilities)
  const refreshDeviceCapabilities = useAppStore((s) => s.refreshDeviceCapabilities)
  const showToast = useAppStore((s) => s.showToast)

  const [caps, setCaps] = useState<DeviceCapabilities | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [modeUi, setModeUi] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  /** Scene combo A local drafts (write-only) */
  const [sceneHeat, setSceneHeat] = useState(true)
  const [sceneDir, setSceneDir] = useState(0)
  const [sceneDirInterval, setSceneDirInterval] = useState(60)
  const [sceneSpeed, setSceneSpeed] = useState(1)
  const [sceneSpeedInterval, setSceneSpeedInterval] = useState(60)
  const [sceneMinutes, setSceneMinutes] = useState(10)

  useEffect(() => {
    if (!hydrated) return
    if (!cachedEntry?.caps) return
    setCaps(cachedEntry.caps)
    setValues(cachedEntry.caps.values || {})
  }, [hydrated, cachedEntry])

  useEffect(() => {
    if (!hydrated) return
    if (dataSource !== 'live') {
      setValues({
        on: false,
        heating: false,
        'battery-level': 80,
        'device-state': 6,
      })
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

  useEffect(() => {
    const st = Number(values['device-state'])
    if (st >= 0 && st <= 2) setModeUi(st)
  }, [values['device-state']])

  const powerOn = Boolean(values.on)
  const heating = Boolean(values.heating)
  const battery = Number(values['battery-level'])
  const deviceState = Number(values['device-state'] ?? 6)
  const batteryLabel = Number.isFinite(battery) ? `${battery}%` : '—'

  const workTimeRange = useMemo(() => {
    const prop = caps?.properties?.find((p) => p.name === 'working-time-a')
    const r = prop?.range
    if (Array.isArray(r) && r.length >= 2) {
      return {
        min: Number(r[0]) || 5,
        max: Number(r[1]) || 10,
        step: Number(r[2]) || 1,
      }
    }
    return { min: 5, max: 10, step: 1 }
  }, [caps])

  const setPropValue = async (name: string, value: unknown) => {
    const prev = values[name]
    const nextValues = { ...values, [name]: value }
    setValues(nextValues)
    if (caps) rememberCapabilities(device.id, { ...caps, values: nextValues })
    if (dataSource !== 'live') return
    setBusy(name)
    try {
      await bridgeApi.setProp(device.id, name, value)
    } catch (err) {
      const rolled = { ...values, [name]: prev }
      setValues(rolled)
      if (caps) rememberCapabilities(device.id, { ...caps, values: rolled })
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const togglePower = async () => {
    const next = !powerOn
    await setPropValue('on', next)
    if (next) {
      setValues((v) => ({ ...v, 'device-state': modeUi }))
    } else {
      setValues((v) => ({ ...v, 'device-state': 6 }))
    }
  }

  const selectMode = async (next: number) => {
    setModeUi(next)
    const prevState = values['device-state']
    setValues((v) => ({ ...v, mode: next, 'device-state': next }))
    if (caps) {
      rememberCapabilities(device.id, {
        ...caps,
        values: { ...values, mode: next, 'device-state': next },
      })
    }
    if (dataSource !== 'live') return
    setBusy('mode')
    try {
      await bridgeApi.setProp(device.id, 'mode', next)
      showToast("动作已执行")
    } catch (err) {
      setModeUi(Number(prevState) <= 2 ? Number(prevState) : modeUi)
      setValues((v) => ({ ...v, 'device-state': prevState }))
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const applySceneA = async () => {
    const minutes = Math.min(
      workTimeRange.max,
      Math.max(workTimeRange.min, sceneMinutes),
    )
    setBusy('scene-mode-set-a')
    try {
      if (dataSource === 'live') {
        await bridgeApi.runDeviceAction(device.id, 'scene-mode-set-a', [
          sceneHeat,
          sceneDir,
          sceneDirInterval,
          sceneSpeed,
          sceneSpeedInterval,
          minutes,
        ])
      }
      setValues((v) => ({
        ...v,
        on: true,
        heating: sceneHeat,
        'device-state': 3,
      }))
      if (caps) {
        rememberCapabilities(device.id, {
          ...caps,
          values: {
            ...values,
            on: true,
            heating: sceneHeat,
            'device-state': 3,
          },
        })
      }
      showToast("动作已执行")
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const currentMode = MODES.find((m) => m.value === modeUi) ?? MODES[0]

  return (
    <div className="detail-layout massager-layout">
      <section className="panel hero-panel template-hero massager-hero">
        <div className="massager-hero-top">
          <div className={`massager-icon${heating ? ' heat' : ''}`} aria-hidden>
            {heating ? '♨' : '◎'}
          </div>
          <div className="massager-status-row">
            <span className={`massager-chip${powerOn ? ' on' : ''}`}>
              {pickLabel(MASSAGER_STATE_LABELS, stateLabelKey(deviceState), '未知状态')}
            </span>
            <span className="massager-chip battery">
              电量: {batteryLabel}
            </span>
            {heating ? (
              <span className="massager-chip heat">加热中</span>
            ) : null}
          </div>
        </div>

        <div className="detail-power-wrap">
          <DetailPowerButton
            on={powerOn}
            label={powerOn ? "已开启" : "已关闭"}
            busy={busy === 'on'}
            onClick={() => void togglePower()}
          />
        </div>

        {syncing ? <p className="meta soft">正在同步…</p> : null}
      </section>

      <section className={`panel plug-card-panel${powerOn ? '' : ' massager-dimmed'}`}>
        <h2>标准模式</h2>
        <div className="massager-mode-row">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`massager-mode-chip${modeUi === m.value ? ' active' : ''}`}
              disabled={!!busy || !powerOn}
              onClick={() => void selectMode(m.value)}
            >
              <span>{pickLabel(MASSAGER_MODE_LABELS, m.key)}</span>
            </button>
          ))}
        </div>
        <p className="meta soft">
          {`当前：${pickLabel(MASSAGER_MODE_LABELS, currentMode.key)}（模式属性为写入项，以设备实际状态为准）`}
        </p>
      </section>

      <section className={`panel plug-card-panel${powerOn ? '' : ' massager-dimmed'}`}>
        <div className="massager-toggle-row">
          <div>
            <strong>热敷</strong>
            <p className="meta soft">开启后颈部加热</p>
          </div>
          <button
            type="button"
            className={`switch${heating ? ' on' : ''}`}
            disabled={busy === 'heating' || !powerOn}
            onClick={() => void setPropValue('heating', !heating)}
          />
        </div>
      </section>

      <section className={`panel plug-card-panel${powerOn ? '' : ' massager-dimmed'}`}>
        <h2>自定义场景</h2>
        <p className="meta soft">调用场景组合 1（scene-mode-set-a）</p>

        <div className="massager-scene-grid">
          <label className="massager-field">
            <span>热敷</span>
            <button
              type="button"
              className={`switch${sceneHeat ? ' on' : ''}`}
              disabled={!!busy || !powerOn}
              onClick={() => setSceneHeat((v) => !v)}
            />
          </label>

          <label className="massager-field">
            <span>转向</span>
            <div className="massager-seg">
              <button
                type="button"
                className={sceneDir === 0 ? 'active' : ''}
                disabled={!!busy || !powerOn}
                onClick={() => setSceneDir(0)}
              >
                正转
              </button>
              <button
                type="button"
                className={sceneDir === 1 ? 'active' : ''}
                disabled={!!busy || !powerOn}
                onClick={() => setSceneDir(1)}
              >
                反转
              </button>
            </div>
          </label>

          <label className="massager-field">
            <span>换向间隔</span>
            <div className="massager-seg">
              {[0, 60, 120, 180].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={sceneDirInterval === n ? 'active' : ''}
                  disabled={!!busy || !powerOn}
                  onClick={() => setSceneDirInterval(n)}
                >
                  {n === 0 ? "关" : `${n}s`}
                </button>
              ))}
            </div>
          </label>

          <label className="massager-field">
            <span>转速</span>
            <div className="massager-seg">
              {[
                { v: 0, k: 'off' as const },
                { v: 1, k: 'slow' as const },
                { v: 2, k: 'fast' as const },
              ].map((s) => (
                <button
                  key={s.v}
                  type="button"
                  className={sceneSpeed === s.v ? 'active' : ''}
                  disabled={!!busy || !powerOn}
                  onClick={() => setSceneSpeed(s.v)}
                >
                  {pickLabel(MASSAGER_SPEED_LABELS, s.k)}
                </button>
              ))}
            </div>
          </label>

          <label className="massager-field">
            <span>换速间隔</span>
            <div className="massager-seg">
              {[0, 60, 120, 180].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={sceneSpeedInterval === n ? 'active' : ''}
                  disabled={!!busy || !powerOn}
                  onClick={() => setSceneSpeedInterval(n)}
                >
                  {n === 0 ? "关" : `${n}s`}
                </button>
              ))}
            </div>
          </label>

          <label className="massager-field">
            <span>工作时长</span>
            <div className="massager-seg">
              {Array.from(
                {
                  length:
                    Math.floor((workTimeRange.max - workTimeRange.min) / workTimeRange.step) + 1,
                },
                (_, i) => workTimeRange.min + i * workTimeRange.step,
              ).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={sceneMinutes === n ? 'active' : ''}
                  disabled={!!busy || !powerOn}
                  onClick={() => setSceneMinutes(n)}
                >
                  {n}
                  分钟
                </button>
              ))}
            </div>
          </label>
        </div>

        <button
          type="button"
          className="btn btn-primary massager-scene-apply"
          disabled={!!busy || !powerOn}
          onClick={() => void applySceneA()}
        >
          应用场景
        </button>
      </section>

      <DeviceCapabilityPanel
        device={device}
        asSupplement
        excludeNames={MASSAGER_TEMPLATE_PROPS}
      />
    </div>
  )
}
