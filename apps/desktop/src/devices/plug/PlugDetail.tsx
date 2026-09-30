import { useEffect, useMemo, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { bridgeApi } from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { useAppStore } from '@/stores/appStore'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import { DetailPowerButton } from '@/devices/shared/DetailPowerButton'
import { PlugPowerChart } from './PlugPowerChart'
import '@/devices/shared/detail.css'

/** Covered by the plug template UI — Spec panel shows the remainder */
const PLUG_TEMPLATE_PROPS = [
  'on',
  'on-2',
  'on_2',
  'on-8',
  'on_8',
  'fault',
  'status',
  'device-fault',
  'duration',
  'left-time',
  'electric-power',
  'power-consumption',
  'temperature',
  'working-time',
  'max-power',
  'over-temperature-protection',
  'data-value',
  'power_cost_today',
  'power_cost_month',
  'power-cost-today',
  'power-cost-month',
]

interface Props {
  device: Device
}

const DELAY_PRESETS = [1, 5, 10, 15, 30, 60, 120]

function fmtKwh(v: number | undefined | null) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v > 0 && v < 0.1) return '<0.1'
  if (v < 10) return v.toFixed(1)
  return v.toFixed(1)
}

function fmtWatts(v: number | undefined | null) {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

export function PlugDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cached = useAppStore((s) => s.deviceCache[device.id])
  const rememberDeviceState = useAppStore((s) => s.rememberDeviceState)
  const refreshDeviceSnapshot = useAppStore((s) => s.refreshDeviceSnapshot)
  const showToast = useAppStore((s) => s.showToast)

  const [power, setPower] = useState(Boolean(device.preview?.power))
  const [delayOff, setDelayOff] = useState(false)
  const [delayMinutes, setDelayMinutes] = useState(5)
  const [delayLeft, setDelayLeft] = useState(0)
  const [electricPower, setElectricPower] = useState<number | undefined>()
  const [todayKwh, setTodayKwh] = useState<number | undefined>()
  const [monthKwh, setMonthKwh] = useState<number | undefined>()
  const [timerOn, setTimerOn] = useState(false)
  const [temperature, setTemperature] = useState<number | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const hasCache = Boolean(cached)

  useEffect(() => {
    if (!hydrated || !cached) return
    if (cached.power !== undefined) setPower(Boolean(cached.power))
    if (cached.delayOff !== undefined) setDelayOff(Boolean(cached.delayOff))
    if (cached.delayMinutes !== undefined) {
      const mins = Math.max(1, Number(cached.delayMinutes) || 5)
      // Device may report duration=1 while idle; keep a sensible preset for UI
      setDelayMinutes(!cached.delayOff && mins <= 1 ? 5 : mins)
    }
    if (cached.delayLeft !== undefined) setDelayLeft(Number(cached.delayLeft) || 0)
    if (cached.electricPower !== undefined) setElectricPower(cached.electricPower)
    if (cached.powerCostToday !== undefined) setTodayKwh(cached.powerCostToday)
    if (cached.powerCostMonth !== undefined) setMonthKwh(cached.powerCostMonth)
    if (cached.timerOn !== undefined) setTimerOn(Boolean(cached.timerOn))
    if (cached.temperature !== undefined) setTemperature(cached.temperature)
  }, [hydrated, cached])

  useEffect(() => {
    if (!hydrated || dataSource !== 'live') {
      if (dataSource !== 'live') {
        setElectricPower(2)
        setTodayKwh(0.05)
        setMonthKwh(80.7)
        setDelayMinutes(5)
      }
      return
    }
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

  const delayProp = 'on-8'
  const durationProp = 'duration'

  const togglePower = async () => {
    const next = !power
    setPower(next)
    rememberDeviceState(device.id, { power: next })
    if (dataSource !== 'live') return
    setBusy('power')
    try {
      await bridgeApi.setSwitch(device.id, next)
    } catch (err) {
      setPower(!next)
      rememberDeviceState(device.id, { power: !next })
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const setDelay = async (enabled: boolean, minutes = delayMinutes) => {
    const prevOff = delayOff
    const prevMin = delayMinutes
    setDelayOff(enabled)
    setDelayMinutes(minutes)
    rememberDeviceState(device.id, { delayOff: enabled, delayMinutes: minutes })
    if (dataSource !== 'live') return
    setBusy('delay')
    try {
      if (enabled) {
        await bridgeApi.setProp(device.id, durationProp, minutes)
        await bridgeApi.setProp(device.id, delayProp, true)
      } else {
        await bridgeApi.setProp(device.id, delayProp, false)
      }
      await refreshDeviceSnapshot(device.id)
    } catch (err) {
      setDelayOff(prevOff)
      setDelayMinutes(prevMin)
      rememberDeviceState(device.id, { delayOff: prevOff, delayMinutes: prevMin })
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const timerHint = useMemo(() => {
    if (timerOn) return "运行中"
    return "未启用"
  }, [timerOn])

  return (
    <div className="detail-layout plug-layout">
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

      <section className="panel plug-card-panel">
        <div className="plug-card-head row">
          <div>
            <strong>延时关闭</strong>
            {delayOff && delayLeft > 0 ? (
              <p className="meta soft">
                {`剩余约 ${delayLeft} 分钟`}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className={`switch${delayOff ? ' on' : ''}`}
            disabled={busy === 'delay'}
            onClick={() => void setDelay(!delayOff, delayMinutes || 5)}
          />
        </div>
        <div className={`plug-delay-presets${delayOff ? '' : ' disabled'}`}>
          <span className="meta soft">延迟时间</span>
          <div className="plug-chip-row">
            {DELAY_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                className={`plug-chip${delayMinutes === m ? ' active' : ''}`}
                disabled={!delayOff || busy === 'delay'}
                onClick={() => void setDelay(true, m)}
              >
                {m >= 60 ? `${m / 60}小时` : `${m}分钟`}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel plug-card-panel">
        <h2>用电信息</h2>
        <div className="metric-row plug-metrics">
          <div>
            <span>今日用电(度)</span>
            <strong>{fmtKwh(todayKwh)}</strong>
          </div>
          <div>
            <span>近一月用电(度)</span>
            <strong>{fmtKwh(monthKwh)}</strong>
          </div>
          <div>
            <span>当前功率</span>
            <strong>
              {fmtWatts(electricPower)}
              <small> W</small>
            </strong>
          </div>
        </div>
        {temperature != null ? (
          <p className="meta soft">
            插座温度: {temperature}°C
          </p>
        ) : null}
      </section>

      <PlugPowerChart deviceId={device.id} />

      <section className="panel plug-card-panel plug-timer">
        <div className="plug-card-head row">
          <div className="plug-timer-title">
            <span className="plug-timer-icon" aria-hidden>
              ⏱
            </span>
            <strong>定时</strong>
          </div>
          <span className={`plug-timer-badge${timerOn ? ' on' : ''}`}>
            {timerHint}
          </span>
        </div>
        <p className="meta soft">复杂定时请在米家 App 中编辑；此处显示当前定时状态。</p>
      </section>

      <DeviceCapabilityPanel
        device={device}
        asSupplement
        excludeNames={PLUG_TEMPLATE_PROPS}
      />
    </div>
  )
}
