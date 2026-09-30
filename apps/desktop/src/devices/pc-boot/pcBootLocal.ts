/** Local timer / countdown / op-log for hipc.plug.* (device Spec has no cloud timer). */

export type PcBootAction = 'on' | 'off'

export type PcBootTimer = {
  enabled: boolean
  /** HH:mm local */
  time: string
  action: PcBootAction
  /** Last calendar day (YYYY-MM-DD) this timer already fired */
  lastFiredDay?: string
}

export type PcBootCountdown = {
  action: PcBootAction
  /** Unix ms when it should fire; null = idle */
  endsAt: number | null
}

export type PcBootLogEntry = {
  id: string
  at: number
  /** key under PCBOOT_LOG_LABELS or plain text */
  key: string
  detail?: string
}

export type PcBootDueJob = {
  deviceId: string
  action: PcBootAction
  logKey: string
  kind: 'timer' | 'countdown'
}

type DeviceLocal = {
  timer: PcBootTimer
  countdown: PcBootCountdown
  logs: PcBootLogEntry[]
}

const STORAGE_KEY = 'mi-home:pc-boot-local:v1'
const MAX_LOGS = 80

const defaultLocal = (): DeviceLocal => ({
  timer: { enabled: false, time: '08:00', action: 'on' },
  countdown: { action: 'off', endsAt: null },
  logs: [],
})

function readAll(): Record<string, DeviceLocal> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, DeviceLocal>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, DeviceLocal>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function loadPcBootLocal(deviceId: string): DeviceLocal {
  const all = readAll()
  const cur = all[deviceId]
  if (!cur) return defaultLocal()
  return {
    timer: { ...defaultLocal().timer, ...cur.timer },
    countdown: { ...defaultLocal().countdown, ...cur.countdown },
    logs: Array.isArray(cur.logs) ? cur.logs : [],
  }
}

export function savePcBootLocal(deviceId: string, next: DeviceLocal) {
  const all = readAll()
  all[deviceId] = {
    ...next,
    logs: next.logs.slice(0, MAX_LOGS),
  }
  writeAll(all)
}

export function appendPcBootLog(
  deviceId: string,
  key: string,
  detail?: string,
): PcBootLogEntry[] {
  const cur = loadPcBootLocal(deviceId)
  const entry: PcBootLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    key,
    detail,
  }
  const logs = [entry, ...cur.logs].slice(0, MAX_LOGS)
  savePcBootLocal(deviceId, { ...cur, logs })
  return logs
}

export function clearPcBootLogs(deviceId: string): PcBootLogEntry[] {
  const cur = loadPcBootLocal(deviceId)
  savePcBootLocal(deviceId, { ...cur, logs: [] })
  return []
}

export function savePcBootTimer(deviceId: string, timer: PcBootTimer) {
  const cur = loadPcBootLocal(deviceId)
  savePcBootLocal(deviceId, { ...cur, timer })
}

export function savePcBootCountdown(deviceId: string, countdown: PcBootCountdown) {
  const cur = loadPcBootLocal(deviceId)
  savePcBootLocal(deviceId, { ...cur, countdown })
}

export function formatRemain(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True when local clock HH:mm matches timer and it has not fired today. */
export function timerShouldFire(timer: PcBootTimer, now = new Date()): boolean {
  if (!timer.enabled) return false
  const [hh, mm] = timer.time.split(':').map((x) => Number(x))
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false
  if (now.getHours() !== hh || now.getMinutes() !== mm) return false
  return timer.lastFiredDay !== todayKey(now)
}

/** Claim due timer/countdown jobs (marks them handled in storage). */
export function claimDuePcBootJobs(now = Date.now()): PcBootDueJob[] {
  const all = readAll()
  const jobs: PcBootDueJob[] = []
  let changed = false
  const date = new Date(now)

  for (const [deviceId, raw] of Object.entries(all)) {
    const local: DeviceLocal = {
      timer: { ...defaultLocal().timer, ...raw.timer },
      countdown: { ...defaultLocal().countdown, ...raw.countdown },
      logs: Array.isArray(raw.logs) ? raw.logs : [],
    }

    if (local.countdown.endsAt != null && now >= local.countdown.endsAt) {
      jobs.push({
        deviceId,
        action: local.countdown.action,
        kind: 'countdown',
        logKey:
          local.countdown.action === 'on' ? LOG_KEYS.countdownOn : LOG_KEYS.countdownOff,
      })
      local.countdown = { ...local.countdown, endsAt: null }
      changed = true
    }

    if (timerShouldFire(local.timer, date)) {
      jobs.push({
        deviceId,
        action: local.timer.action,
        kind: 'timer',
        logKey: local.timer.action === 'on' ? LOG_KEYS.timerOn : LOG_KEYS.timerOff,
      })
      local.timer = { ...local.timer, lastFiredDay: todayKey(date) }
      changed = true
    }

    all[deviceId] = local
  }

  if (changed) writeAll(all)
  return jobs
}

export const LOG_KEYS = {
  powerOn: 'powerOn',
  powerOff: 'powerOff',
  indicatorOn: 'indicatorOn',
  indicatorOff: 'indicatorOff',
  childLockOn: 'childLockOn',
  childLockOff: 'childLockOff',
  restart: 'restart',
  forceOff: 'forceOff',
  timerOn: 'timerOn',
  timerOff: 'timerOff',
  countdownOn: 'countdownOn',
  countdownOff: 'countdownOff',
} as const
