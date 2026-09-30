import { useEffect, useMemo, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { bridgeApi, type DeviceCapabilities } from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { useAppStore } from '@/stores/appStore'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import { DetailPowerButton } from '@/devices/shared/DetailPowerButton'
import '@/devices/shared/detail.css'
import './dehumidifier.css'

/** Props covered by this template — hidden from Spec supplement */
const DERH_TEMPLATE_PROPS = [
  'on',
  'on-2',
  'fault',
  'mode',
  'mode-2',
  'target-humidity',
  'relative-humidity',
  'temperature',
  'alarm',
  'on-5',
  'mode-5',
  'physical-controls-locked',
  'delay',
  'delay-time',
  'delay-remain-time',
  'dry-after-off',
  'dry-left-time',
  'is-warming-up',
  'toggle',
  'loop-mode',
  'reset-filter',
]

const MODES = [
  { value: 0, label: '智能模式', icon: '◎' },
  { value: 1, label: '睡眠模式', icon: '☾' },
  { value: 2, label: '干衣模式', icon: '👕' },
]

const LIGHT_MODES = [
  { value: 0, label: '关闭' },
  { value: 1, label: '微光' },
  { value: 2, label: '亮光' },
]

const DELAY_PRESETS = [30, 60, 120, 180, 360, 720]

const FAULT_LABELS = [
  '运行正常',
  '水满保护',
  '温湿度传感器故障',
  '铜管温度故障',
  '板间通讯故障',
  '过滤网清洁提醒',
  '除霜状态',
  '风机故障',
  '压缩机过载保护',
  '缺氟保护',
] as const

interface Props {
  device: Device
}

function resolvePropName(
  caps: DeviceCapabilities | null,
  values: Record<string, unknown>,
  candidates: string[],
): string {
  const known = new Set<string>([
    ...(caps?.properties?.map((p) => p.name) || []),
    ...Object.keys(values),
  ])
  for (const name of candidates) {
    if (known.has(name)) return name
  }
  return candidates[0]
}

function formatMinutes(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return '—'
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  if (h <= 0) return `${m}分钟`
  if (m <= 0) return `${h}小时`
  return `${h}小时 ${m}分钟`
}

function formatDryLeft(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m <= 0) return `${s}秒`
  return `${m}:${String(s).padStart(2, '0')}`
}

function delayPresetLabel(minutes: number): string {
  return minutes >= 60 ? `${minutes / 60}小时` : `${minutes}分钟`
}

export function DehumidifierDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cachedEntry = useAppStore((s) => s.capabilityCache[device.id])
  const rememberCapabilities = useAppStore((s) => s.rememberCapabilities)
  const refreshDeviceCapabilities = useAppStore((s) => s.refreshDeviceCapabilities)
  const showToast = useAppStore((s) => s.showToast)

  const [caps, setCaps] = useState<DeviceCapabilities | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [targetHum, setTargetHum] = useState(60)

  const powerKey = resolvePropName(caps, values, ['on-2', 'on'])
  const modeKey = resolvePropName(caps, values, ['mode-2', 'mode'])
  const lightOnKey = resolvePropName(caps, values, ['on-5'])
  const lightModeKey = resolvePropName(caps, values, ['mode-5'])

  useEffect(() => {
    if (!hydrated) return
    if (!cachedEntry?.caps) return
    setCaps(cachedEntry.caps)
    const v = cachedEntry.caps.values || {}
    setValues(v)
    const th = Number(v['target-humidity'])
    if (Number.isFinite(th)) setTargetHum(th)
  }, [hydrated, cachedEntry])

  useEffect(() => {
    if (!hydrated) return
    if (dataSource !== 'live') {
      const mock = {
        'on-2': true,
        fault: 0,
        'mode-2': 0,
        'target-humidity': 60,
        'relative-humidity': 63,
        temperature: 28,
        alarm: true,
        'on-5': true,
        'mode-5': 2,
        'physical-controls-locked': false,
        delay: false,
        'delay-time': 0,
        'delay-remain-time': 0,
        'dry-after-off': true,
        'dry-left-time': 0,
        'is-warming-up': false,
      }
      setValues(mock)
      setTargetHum(60)
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

  const humRange = useMemo(() => {
    const prop = caps?.properties?.find((p) => p.name === 'target-humidity')
    const r = prop?.range
    if (Array.isArray(r) && r.length >= 2) {
      return {
        min: Number(r[0]) || 30,
        max: Number(r[1]) || 70,
        step: Number(r[2]) || 1,
      }
    }
    return { min: 30, max: 70, step: 1 }
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
      showToast(err instanceof Error ? err.message : '同步失败')
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
      if (name === 'toggle') {
        const next = !Boolean(values[powerKey])
        const nextValues = { ...values, [powerKey]: next }
        setValues(nextValues)
        if (caps) rememberCapabilities(device.id, { ...caps, values: nextValues })
      }
      showToast('动作已执行')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '同步失败')
    } finally {
      setBusy(null)
    }
  }

  const powerOn = Boolean(values[powerKey])
  const mode = Number(values[modeKey] ?? 0)
  const humidity = Number(values['relative-humidity'])
  const temperature = Number(values.temperature)
  const fault = Number(values.fault ?? 0)
  const alarm = Boolean(values.alarm)
  const childLock = Boolean(values['physical-controls-locked'])
  const dryAfterOff = Boolean(values['dry-after-off'])
  const warmingUp = Boolean(values['is-warming-up'])
  const lightOn = Boolean(values[lightOnKey])
  const lightMode = Number(values[lightModeKey] ?? 0)
  const delayOn = Boolean(values.delay)
  const delayTime = Number(values['delay-time'] ?? 0)
  const delayRemain = Number(values['delay-remain-time'] ?? 0)
  const dryLeft = Number(values['dry-left-time'] ?? 0)

  const currentMode = MODES.find((m) => m.value === mode) ?? MODES[0]
  const faultLabel = FAULT_LABELS[fault] || '未知故障'

  const selectMode = async (next: number) => {
    await setPropValue(modeKey, next)
  }

  const commitTarget = async (next: number) => {
    const clamped = Math.min(
      humRange.max,
      Math.max(humRange.min, Math.round(next / humRange.step) * humRange.step),
    )
    setTargetHum(clamped)
    await setPropValue('target-humidity', clamped)
  }

  const nudgeTarget = async (delta: number) => {
    const next = targetHum + delta * humRange.step
    if (next < humRange.min || next > humRange.max) return
    await commitTarget(next)
  }

  const setDelay = async (on: boolean, minutes?: number) => {
    const mins = minutes ?? (delayTime || 60)
    const prev = { ...values }
    const nextValues = {
      ...values,
      delay: on,
      'delay-time': on ? mins : 0,
      'delay-remain-time': on ? mins : 0,
    }
    setValues(nextValues)
    if (caps) rememberCapabilities(device.id, { ...caps, values: nextValues })
    if (dataSource !== 'live') return
    setBusy('delay')
    try {
      if (on) {
        await bridgeApi.setProp(device.id, 'delay-time', mins)
        await bridgeApi.setProp(device.id, 'delay', true)
      } else {
        await bridgeApi.setProp(device.id, 'delay', false)
      }
    } catch (err) {
      setValues(prev)
      if (caps) rememberCapabilities(device.id, { ...caps, values: prev })
      showToast(err instanceof Error ? err.message : '同步失败')
    } finally {
      setBusy(null)
    }
  }

  const humPct =
    ((targetHum - humRange.min) / (humRange.max - humRange.min || 1)) * 100
  const gaugeHum = Number.isFinite(humidity) ? Math.min(100, Math.max(0, humidity)) : 50

  return (
    <div className="detail-layout derh-layout">
      <section className="panel hero-panel template-hero derh-hero">
        <div className="derh-hero-top">
          <div className="derh-icon" aria-hidden>
            💧
          </div>
          <div>
            <p className="derh-hero-status">
              {currentMode.label}
              {Number.isFinite(temperature) ? ` · ${temperature}°C` : ''}
              {warmingUp ? ' · 预热中' : ''}
            </p>
            <span className={`derh-fault${fault === 0 ? ' ok' : ''}`}>{faultLabel}</span>
          </div>
        </div>

        <div
          className="derh-gauge"
          style={{ ['--derh-hum' as string]: String(gaugeHum) }}
        >
          <div className="derh-gauge-ring">
            <strong>{Number.isFinite(humidity) ? humidity : '—'}</strong>
            <span>当前湿度</span>
            <em>设定 {Number.isFinite(targetHum) ? `${targetHum}%` : '—'}</em>
          </div>
        </div>

        <div className="detail-power-wrap">
          <DetailPowerButton
            on={powerOn}
            size="md"
            label={powerOn ? '已开启' : '已关闭'}
            busy={busy === powerKey || busy === 'toggle'}
            onClick={() => void setPropValue(powerKey, !powerOn)}
          />
        </div>

        {syncing ? <p className="meta soft">正在同步…</p> : null}
      </section>

      <section className={`panel plug-card-panel${powerOn ? '' : ' derh-dimmed'}`}>
        <h2>模式</h2>
        <div className="derh-mode-row">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`derh-mode-chip${mode === m.value ? ' active' : ''}`}
              disabled={!!busy || !powerOn}
              onClick={() => void selectMode(m.value)}
            >
              <i aria-hidden>{m.icon}</i>
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={`panel plug-card-panel${powerOn ? '' : ' derh-dimmed'}`}>
        <div className="plug-card-head row">
          <strong>设定湿度</strong>
          <span className="derh-hum-value">
            {targetHum}
            <small>%</small>
          </span>
        </div>
        <div className="derh-hum-controls">
          <button
            type="button"
            className="derh-step-btn"
            disabled={!!busy || !powerOn || targetHum <= humRange.min}
            onClick={() => void nudgeTarget(-1)}
            aria-label="降低湿度"
          >
            −
          </button>
          <input
            className="derh-slider"
            type="range"
            min={humRange.min}
            max={humRange.max}
            step={humRange.step}
            value={targetHum}
            disabled={busy === 'target-humidity' || !powerOn}
            style={{
              background: `linear-gradient(90deg, #38bdf8 ${humPct}%, var(--switch-track) ${humPct}%)`,
            }}
            onChange={(e) => setTargetHum(Number(e.target.value))}
            onMouseUp={(e) =>
              void commitTarget(Number((e.target as HTMLInputElement).value))
            }
            onTouchEnd={(e) =>
              void commitTarget(Number((e.target as HTMLInputElement).value))
            }
          />
          <button
            type="button"
            className="derh-step-btn"
            disabled={!!busy || !powerOn || targetHum >= humRange.max}
            onClick={() => void nudgeTarget(1)}
            aria-label="提高湿度"
          >
            +
          </button>
        </div>
        <p className="meta soft">
          {humRange.min}–{humRange.max}%
          {mode === 2 ? ' · 干衣模式下设定湿度可能不生效' : ''}
        </p>
      </section>

      <section className="panel plug-card-panel">
        <h2>环境</h2>
        <div className="metric-row">
          <div>
            <span>当前湿度</span>
            <strong>{Number.isFinite(humidity) ? `${humidity}%` : '—'}</strong>
          </div>
          <div>
            <span>温度</span>
            <strong>
              {Number.isFinite(temperature) ? `${temperature}°C` : '—'}
            </strong>
          </div>
          <div>
            <span>风干剩余</span>
            <strong>{formatDryLeft(dryLeft)}</strong>
          </div>
        </div>
      </section>

      <section className="panel plug-card-panel">
        <div className="derh-toggle-row">
          <div>
            <strong>提示音</strong>
            <p className="meta soft">操作时播放提示音</p>
          </div>
          <button
            type="button"
            className={`switch${alarm ? ' on' : ''}`}
            disabled={busy === 'alarm'}
            onClick={() => void setPropValue('alarm', !alarm)}
          />
        </div>
        <div className="derh-toggle-row">
          <div>
            <strong>童锁</strong>
            <p className="meta soft">锁定机身物理按键</p>
          </div>
          <button
            type="button"
            className={`switch${childLock ? ' on' : ''}`}
            disabled={busy === 'physical-controls-locked'}
            onClick={() =>
              void setPropValue('physical-controls-locked', !childLock)
            }
          />
        </div>
        <div className="derh-toggle-row">
          <div>
            <strong>关机风干</strong>
            <p className="meta soft">关机后继续吹风，减少机身潮湿</p>
          </div>
          <button
            type="button"
            className={`switch${dryAfterOff ? ' on' : ''}`}
            disabled={busy === 'dry-after-off'}
            onClick={() => void setPropValue('dry-after-off', !dryAfterOff)}
          />
        </div>
      </section>

      <section className="panel plug-card-panel">
        <div className="plug-card-head row">
          <div>
            <strong>指示灯</strong>
            <p className="meta soft">面板指示灯亮度</p>
          </div>
          <button
            type="button"
            className={`switch${lightOn ? ' on' : ''}`}
            disabled={busy === lightOnKey}
            onClick={() => void setPropValue(lightOnKey, !lightOn)}
          />
        </div>
        <div className={`derh-light-row${lightOn ? '' : ' derh-dimmed'}`}>
          {LIGHT_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`plug-chip${lightMode === m.value ? ' active' : ''}`}
              disabled={!!busy || !lightOn}
              onClick={() => void setPropValue(lightModeKey, m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel plug-card-panel">
        <div className="plug-card-head row">
          <div>
            <strong>延时</strong>
            {delayOn && delayRemain > 0 ? (
              <p className="meta soft">剩余 {formatMinutes(delayRemain)}</p>
            ) : (
              <p className="meta soft">到时自动开关机</p>
            )}
          </div>
          <button
            type="button"
            className={`switch${delayOn ? ' on' : ''}`}
            disabled={busy === 'delay'}
            onClick={() => void setDelay(!delayOn, delayTime || 60)}
          />
        </div>
        <div className={`plug-delay-presets${delayOn ? '' : ' disabled'}`}>
          <span className="meta soft">延时时长</span>
          <div className="plug-chip-row">
            {DELAY_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                className={`plug-chip${delayTime === m ? ' active' : ''}`}
                disabled={!delayOn || busy === 'delay'}
                onClick={() => void setDelay(true, m)}
              >
                {delayPresetLabel(m)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel plug-card-panel">
        <h2>更多</h2>
        <div className="derh-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => void runAction('loop-mode')}
          >
            循环切换模式
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => void runAction('reset-filter')}
          >
            重置滤网
          </button>
        </div>
      </section>

      <DeviceCapabilityPanel
        device={device}
        asSupplement
        excludeNames={DERH_TEMPLATE_PROPS}
      />
    </div>
  )
}
