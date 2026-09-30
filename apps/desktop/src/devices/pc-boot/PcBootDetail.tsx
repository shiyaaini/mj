import { useEffect, useMemo, useState } from 'react'
import type { Device } from '@mi-home/shared'
import {
  bridgeApi,
  type DeviceCapabilities,
  type PcbootOpLogRecord,
} from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { PCBOOT_LOG_LABELS, PCBOOT_STATUS_LABELS, pickLabel } from '@/labels'
import { useAppStore } from '@/stores/appStore'
import { DetailPowerButton } from '@/devices/shared/DetailPowerButton'
import {
  LOG_KEYS,
  appendPcBootLog,
  clearPcBootLogs,
  formatRemain,
  loadPcBootLocal,
  savePcBootCountdown,
  savePcBootTimer,
  type PcBootAction,
  type PcBootCountdown,
  type PcBootLogEntry,
  type PcBootTimer,
} from './pcBootLocal'
import './pc-boot.css'

interface Props {
  device: Device
}

const BUSY_STATUS = new Set([2, 3, 4, 5, 8, 9])

type Sheet = 'timer' | 'countdown' | 'opLog' | null

type DisplayLog = {
  id: string
  at: number
  label: string
  source: 'cloud' | 'local'
}

function statusKey(status: number): string {
  switch (status) {
    case 0:
      return 'poweredOff'
    case 1:
      return 'poweredOn'
    case 2:
      return 'booting'
    case 3:
      return 'shuttingDown'
    case 4:
      return 'rebooting'
    case 5:
      return 'forceRebooting'
    case 6:
      return 'bootFailed'
    case 7:
      return 'shutdownFailed'
    case 8:
      return 'busy'
    case 9:
      return 'forceShuttingDown'
    default:
      return 'poweredOff'
  }
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

export function PcBootDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cachedEntry = useAppStore((s) => s.capabilityCache[device.id])
  const rememberCapabilities = useAppStore((s) => s.rememberCapabilities)
  const refreshDeviceCapabilities = useAppStore((s) => s.refreshDeviceCapabilities)
  const patchDevicePreview = useAppStore((s) => s.patchDevicePreview)
  const showToast = useAppStore((s) => s.showToast)

  const [caps, setCaps] = useState<DeviceCapabilities | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [now, setNow] = useState(() => Date.now())

  const [timer, setTimer] = useState<PcBootTimer>(() => loadPcBootLocal(device.id).timer)
  const [countdown, setCountdown] = useState<PcBootCountdown>(
    () => loadPcBootLocal(device.id).countdown,
  )
  const [logs, setLogs] = useState<PcBootLogEntry[]>(() => loadPcBootLocal(device.id).logs)
  const [cloudLogs, setCloudLogs] = useState<PcbootOpLogRecord[]>([])
  const [cloudLogsLoading, setCloudLogsLoading] = useState(false)
  const [cloudLogsError, setCloudLogsError] = useState<string | null>(null)
  const [cloudReady, setCloudReady] = useState(false)

  const [timerDraft, setTimerDraft] = useState({ time: '08:00', action: 'on' as PcBootAction })
  const [cdMinutes, setCdMinutes] = useState(30)
  const [cdAction, setCdAction] = useState<PcBootAction>('off')

  const reloadLocal = () => {
    const local = loadPcBootLocal(device.id)
    setTimer(local.timer)
    setCountdown(local.countdown)
    setLogs(local.logs)
  }

  useEffect(() => {
    reloadLocal()
    setCloudLogs([])
    setCloudLogsError(null)
    setCloudReady(false)
    setTimerDraft({
      time: loadPcBootLocal(device.id).timer.time,
      action: loadPcBootLocal(device.id).timer.action,
    })
    setCdAction(loadPcBootLocal(device.id).countdown.action)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

  useEffect(() => {
    const onChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ deviceId?: string }>).detail
      if (detail?.deviceId && detail.deviceId !== device.id) return
      reloadLocal()
    }
    window.addEventListener('pc-boot-local-changed', onChanged)
    return () => window.removeEventListener('pc-boot-local-changed', onChanged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

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
        on: Boolean(device.preview?.power ?? true),
        status: device.preview?.power === false ? 0 : 1,
        'children-lock': false,
        'indicate-off': false,
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
  }, [hydrated, dataSource, device.id, device.preview, refreshDeviceCapabilities])

  const pushLog = (key: string, detail?: string) => {
    setLogs(appendPcBootLog(device.id, key, detail))
  }

  // UI clock for countdown remaining; jobs are executed by usePcBootScheduler
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now())
      const local = loadPcBootLocal(device.id)
      setCountdown(local.countdown)
      setTimer(local.timer)
    }, 1000)
    return () => window.clearInterval(id)
  }, [device.id])

  const status = Number(values.status)
  const statusNum = Number.isFinite(status) ? status : Boolean(values.on) ? 1 : 0
  const poweredOn = statusNum === 1 || Boolean(values.on)
  const isBusyStatus = BUSY_STATUS.has(statusNum)
  const indicatorOn = !Boolean(values['indicate-off'] ?? values.indicate_off)
  const childLock = Boolean(values['children-lock'] ?? values.children_lock)

  const statusLabel = useMemo(
    () => pickLabel(PCBOOT_STATUS_LABELS, statusKey(statusNum)),
    [statusNum],
  )

  const countdownRemain =
    countdown.endsAt != null ? Math.max(0, countdown.endsAt - now) : null

  const actionLabel = (action: PcBootAction) => (action === 'on' ? '开机' : '关机')

  const timerHint = timer.enabled
    ? `${timer.time} ${actionLabel(timer.action)}`
    : '未设置'

  const countdownHint =
    countdownRemain != null
      ? `${formatRemain(countdownRemain)} 后${actionLabel(countdown.action)}`
      : '未运行'

  const setPropValue = async (name: string, value: unknown, logKey?: string) => {
    const prev = values[name]
    const nextValues = { ...values, [name]: value }
    setValues(nextValues)
    if (caps) rememberCapabilities(device.id, { ...caps, values: nextValues })
    setBusy(name)
    try {
      if (dataSource === 'live') {
        await bridgeApi.setProp(device.id, name, value)
        window.setTimeout(() => {
          void refreshDeviceCapabilities(device.id)
        }, 600)
      }
      if (name === 'on') {
        patchDevicePreview(device.id, { power: Boolean(value) })
        setValues((v) => ({ ...v, status: value ? 1 : 0 }))
      }
      if (logKey) pushLog(logKey)
      showToast("动作已执行")
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
    if (isBusyStatus || busy) return
    const next = !(statusNum === 1 || Boolean(values.on))
    await setPropValue('on', next, next ? LOG_KEYS.powerOn : LOG_KEYS.powerOff)
  }

  const toggleIndicator = async () => {
    if (busy) return
    // indicate-off: true = LED off
    const nextOff = indicatorOn
    await setPropValue(
      'indicate-off',
      nextOff,
      nextOff ? LOG_KEYS.indicatorOff : LOG_KEYS.indicatorOn,
    )
  }

  const toggleChildLock = async () => {
    if (busy) return
    const next = !childLock
    await setPropValue(
      'children-lock',
      next,
      next ? LOG_KEYS.childLockOn : LOG_KEYS.childLockOff,
    )
  }

  const writeReboot = async (code: 0 | 1 | 2, confirmMsg: string, logKey: string) => {
    if (!window.confirm(confirmMsg)) return
    setBusy(`reboot-${code}`)
    try {
      if (dataSource === 'live') {
        await bridgeApi.setProp(device.id, 'reboot', code)
      }
      pushLog(logKey)
      showToast("动作已执行")
      if (dataSource === 'live') {
        window.setTimeout(() => {
          void refreshDeviceCapabilities(device.id)
        }, 1200)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const loadCloudLogs = async () => {
    if (dataSource !== 'live') {
      setCloudLogs([])
      setCloudLogsError(null)
      setCloudReady(false)
      return
    }
    setCloudLogsLoading(true)
    setCloudLogsError(null)
    try {
      const res = await bridgeApi.getPcbootOpLogs(device.id, {
        model: device.model,
        days: 180,
        limit: 50,
      })
      setCloudLogs(res.records || [])
      setCloudReady(true)
    } catch (err) {
      setCloudLogs([])
      setCloudReady(false)
      setCloudLogsError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setCloudLogsLoading(false)
    }
  }

  const openSheet = (next: Sheet) => {
    if (next === 'timer') {
      setTimerDraft({ time: timer.time, action: timer.action })
    }
    if (next === 'countdown') {
      setCdAction(countdown.action)
      if (countdown.endsAt == null) setCdMinutes(30)
    }
    setSheet(next)
    if (next === 'opLog') {
      void loadCloudLogs()
    }
  }

  const showingCloud = dataSource === 'live' && cloudReady && !cloudLogsError

  const displayLogs: DisplayLog[] = useMemo(() => {
    if (showingCloud || (dataSource === 'live' && cloudLogsLoading)) {
      return cloudLogs.map((r) => ({
        id: r.id,
        at: r.at,
        label: pickLabel(PCBOOT_LOG_LABELS, r.key, r.title || r.key),
        source: 'cloud' as const,
      }))
    }
    return logs.map((entry) => ({
      id: entry.id,
      at: entry.at,
      label: pickLabel(PCBOOT_LOG_LABELS, entry.key, entry.key),
      source: 'local' as const,
    }))
  }, [cloudLogs, cloudLogsLoading, dataSource, logs, showingCloud])

  const logMeta =
    dataSource === 'live' && cloudReady && !cloudLogsError
      ? cloudLogs.length
        ? `${cloudLogs.length} 条`
        : '暂无记录'
      : logs.length
        ? `${logs.length} 条`
        : '暂无记录'

  const saveTimer = () => {
    const next: PcBootTimer = {
      enabled: true,
      time: timerDraft.time,
      action: timerDraft.action,
      lastFiredDay: undefined,
    }
    savePcBootTimer(device.id, next)
    setTimer(next)
    setSheet(null)
    showToast("定时已保存")
  }

  const disableTimer = () => {
    const next: PcBootTimer = { ...timer, enabled: false, lastFiredDay: undefined }
    savePcBootTimer(device.id, next)
    setTimer(next)
    setSheet(null)
    showToast("定时已关闭")
  }

  const startCountdown = () => {
    const mins = Math.max(1, Math.min(24 * 60, Math.round(cdMinutes) || 1))
    const next: PcBootCountdown = {
      action: cdAction,
      endsAt: Date.now() + mins * 60_000,
    }
    savePcBootCountdown(device.id, next)
    setCountdown(next)
    setSheet(null)
    showToast("倒计时已开始")
  }

  const cancelCountdown = () => {
    const next: PcBootCountdown = { ...countdown, endsAt: null }
    savePcBootCountdown(device.id, next)
    setCountdown(next)
    setSheet(null)
    showToast("倒计时已取消")
  }

  const formatLogTime = (at: number) => {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(at))
    } catch {
      const d = new Date(at)
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    }
  }

  return (
    <div className="pcboot-layout">
      <section className="pcboot-hero">
        <DetailPowerButton
          on={poweredOn}
          size="lg"
          label={statusLabel}
          busy={!!busy || isBusyStatus}
          onClick={() => void togglePower()}
        />
        {syncing ? <p className="pcboot-sync">正在同步…</p> : null}
      </section>

      <section className="pcboot-toggles">
        <button
          type="button"
          className={`pcboot-tile${indicatorOn ? ' on' : ''}`}
          disabled={busy === 'indicate-off'}
          onClick={() => void toggleIndicator()}
        >
          <span className="pcboot-tile-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path
                d="M9 18h6M10 21h4M12 3a5 5 0 0 1 3 9c-.8.6-1.3 1.5-1.5 2.5h-3C10.3 13.5 9.8 12.6 9 12a5 5 0 0 1 3-9z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>指示灯</span>
        </button>

        <button
          type="button"
          className={`pcboot-tile${childLock ? ' on' : ''}`}
          disabled={busy === 'children-lock'}
          onClick={() => void toggleChildLock()}
        >
          <span className="pcboot-tile-icon" aria-hidden>
            {childLock ? (
              <svg viewBox="0 0 24 24">
                <rect
                  x="5"
                  y="11"
                  width="14"
                  height="10"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M8 11V8a4 4 0 0 1 8 0v3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24">
                <rect
                  x="5"
                  y="11"
                  width="14"
                  height="10"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M8 11V8a4 4 0 0 1 7.5-1.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </span>
          <span>童锁</span>
        </button>
      </section>

      <section className="pcboot-actions">
        <button
          type="button"
          className="pcboot-action"
          disabled={!!busy || isBusyStatus}
          onClick={() => void writeReboot(0, '确定要重启电脑吗？', LOG_KEYS.restart)}
        >
          <span className="pcboot-action-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path
                d="M20 12a8 8 0 1 1-2.2-5.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M20 4v5h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>重启电脑</span>
        </button>
        <div className="pcboot-actions-divider" aria-hidden />
        <button
          type="button"
          className="pcboot-action"
          disabled={!!busy || isBusyStatus}
          onClick={() => void writeReboot(2, '确定要强制关机吗？', LOG_KEYS.forceOff)}
        >
          <span className="pcboot-action-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path
                d="M12 3v9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M7.05 6.05a7.5 7.5 0 1 0 9.9 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span>强制关机</span>
        </button>
      </section>

      <section className="pcboot-list">
        <button type="button" className="pcboot-list-item" onClick={() => openSheet('timer')}>
          <span className="pcboot-list-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path
                d="M12 8v4l3 2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="pcboot-list-text">
            <span className="pcboot-list-label">定时</span>
            <span className="pcboot-list-meta">{timerHint}</span>
          </span>
          <span className="pcboot-list-chevron" aria-hidden>
            ›
          </span>
        </button>
        <button type="button" className="pcboot-list-item" onClick={() => openSheet('countdown')}>
          <span className="pcboot-list-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path
                d="M7 4h10M7 20h10M8 4c0 4 3 5 4 6s4 2 4 6M16 4c0 4-3 5-4 6s-4 2-4 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="pcboot-list-text">
            <span className="pcboot-list-label">倒计时</span>
            <span className="pcboot-list-meta">{countdownHint}</span>
          </span>
          <span className="pcboot-list-chevron" aria-hidden>
            ›
          </span>
        </button>
        <button type="button" className="pcboot-list-item" onClick={() => openSheet('opLog')}>
          <span className="pcboot-list-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path
                d="M7 7h10M7 12h10M7 17h7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
              <rect
                x="4"
                y="3"
                width="16"
                height="18"
                rx="2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              />
            </svg>
          </span>
          <span className="pcboot-list-text">
            <span className="pcboot-list-label">操作日志</span>
            <span className="pcboot-list-meta">{logMeta}</span>
          </span>
          <span className="pcboot-list-chevron" aria-hidden>
            ›
          </span>
        </button>
      </section>

      {sheet ? (
        <div
          className="pcboot-overlay"
          role="presentation"
          onClick={() => setSheet(null)}
        >
          <div
            className="pcboot-sheet"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pcboot-sheet-head">
              <h2>
                {sheet === 'timer'
                  ? "定时"
                  : sheet === 'countdown'
                    ? "倒计时"
                    : "操作日志"}
              </h2>
              <button
                type="button"
                className="pcboot-sheet-close"
                onClick={() => setSheet(null)}
                aria-label="取消"
              >
                ×
              </button>
            </div>

            {sheet === 'timer' ? (
              <div className="pcboot-sheet-body">
                <p className="pcboot-sheet-hint">每天到点自动开机或关机（需本应用在运行）。</p>
                <label className="pcboot-field">
                  <span>时间</span>
                  <input
                    type="time"
                    value={timerDraft.time}
                    onChange={(e) =>
                      setTimerDraft((d) => ({ ...d, time: e.target.value || '08:00' }))
                    }
                  />
                </label>
                <div className="pcboot-field">
                  <span>动作</span>
                  <div className="pcboot-seg">
                    <button
                      type="button"
                      className={timerDraft.action === 'on' ? 'active' : ''}
                      onClick={() => setTimerDraft((d) => ({ ...d, action: 'on' }))}
                    >
                      开机
                    </button>
                    <button
                      type="button"
                      className={timerDraft.action === 'off' ? 'active' : ''}
                      onClick={() => setTimerDraft((d) => ({ ...d, action: 'off' }))}
                    >
                      关机
                    </button>
                  </div>
                </div>
                <div className="pcboot-sheet-actions">
                  {timer.enabled ? (
                    <button type="button" className="btn btn-ghost" onClick={disableTimer}>
                      关闭定时
                    </button>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={() => setSheet(null)}>
                      取消
                    </button>
                  )}
                  <button type="button" className="btn btn-primary" onClick={saveTimer}>
                    保存定时
                  </button>
                </div>
              </div>
            ) : null}

            {sheet === 'countdown' ? (
              <div className="pcboot-sheet-body">
                <p className="pcboot-sheet-hint">倒计时结束后执行开机或关机（需本应用在运行）。</p>
                {countdownRemain != null ? (
                  <>
                    <p className="pcboot-countdown-live">{formatRemain(countdownRemain)}</p>
                    <p className="pcboot-sheet-hint">
                      {`${formatRemain(countdownRemain)} 后${actionLabel(countdown.action)}`}
                    </p>
                    <div className="pcboot-sheet-actions">
                      <button type="button" className="btn btn-ghost" onClick={() => setSheet(null)}>
                        取消
                      </button>
                      <button type="button" className="btn btn-primary" onClick={cancelCountdown}>
                        取消倒计时
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="pcboot-field">
                      <span>分钟</span>
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={cdMinutes}
                        onChange={(e) => setCdMinutes(Number(e.target.value) || 1)}
                      />
                    </label>
                    <div className="pcboot-presets">
                      {[5, 15, 30, 60, 120].map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={cdMinutes === m ? 'active' : ''}
                          onClick={() => setCdMinutes(m)}
                        >
                          {m < 60 ? `${m}′` : `${m / 60}h`}
                        </button>
                      ))}
                    </div>
                    <div className="pcboot-field">
                      <span>动作</span>
                      <div className="pcboot-seg">
                        <button
                          type="button"
                          className={cdAction === 'on' ? 'active' : ''}
                          onClick={() => setCdAction('on')}
                        >
                          开机
                        </button>
                        <button
                          type="button"
                          className={cdAction === 'off' ? 'active' : ''}
                          onClick={() => setCdAction('off')}
                        >
                          关机
                        </button>
                      </div>
                    </div>
                    <div className="pcboot-sheet-actions">
                      <button type="button" className="btn btn-ghost" onClick={() => setSheet(null)}>
                        取消
                      </button>
                      <button type="button" className="btn btn-primary" onClick={startCountdown}>
                        开始
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {sheet === 'opLog' ? (
              <div className="pcboot-sheet-body">
                <p className="pcboot-sheet-hint">
                  {showingCloud
                    ? '云端开关机记录（prop 3.6 onoff-log）。'
                    : cloudLogsError
                      ? `云端加载失败：${cloudLogsError}，已显示本机记录。`
                      : '记录本应用内的开关机与控制操作。'}
                </p>
                {cloudLogsLoading ? (
                  <p className="pcboot-log-empty">加载中…</p>
                ) : displayLogs.length === 0 ? (
                  <p className="pcboot-log-empty">暂无记录</p>
                ) : (
                  <ul className="pcboot-log-list">
                    {displayLogs.map((entry) => (
                      <li key={entry.id}>
                        <time>{formatLogTime(entry.at)}</time>
                        <span>{entry.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="pcboot-sheet-actions">
                  {showingCloud ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={cloudLogsLoading}
                      onClick={() => void loadCloudLogs()}
                    >
                      刷新
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!logs.length}
                      onClick={() => {
                        setLogs(clearPcBootLogs(device.id))
                        showToast('日志已清空')
                      }}
                    >
                      清空
                    </button>
                  )}
                  <button type="button" className="btn btn-primary" onClick={() => setSheet(null)}>
                    完成
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
