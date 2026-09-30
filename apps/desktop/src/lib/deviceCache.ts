import type { DeviceSnapshot } from '@/api/bridge'

export type CachedDeviceState = {
  power?: boolean
  brightness?: number
  colorTemp?: number
  mode?: string
  pm25?: number
  temperature?: number
  humidity?: number
  filter?: number
  switchName?: string
  /** Instantaneous power (W) */
  electricPower?: number
  /** Today's energy (kWh) */
  powerCostToday?: number
  /** ~30 day energy (kWh) */
  powerCostMonth?: number
  /** Delay-off enabled */
  delayOff?: boolean
  /** Delay minutes */
  delayMinutes?: number
  /** Remaining delay seconds/minutes */
  delayLeft?: number
  /** Countdown/timer running */
  timerOn?: boolean
  timerData?: string
  updatedAt: number
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function bool(v: unknown): boolean | undefined {
  if (v == null) return undefined
  if (typeof v === 'boolean') return v
  if (v === 0 || v === '0' || v === 'false') return false
  if (v === 1 || v === '1' || v === 'true') return true
  return Boolean(v)
}

export function brightRawToUi(raw: number | undefined): number | undefined {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return undefined
  if (raw <= 100) return Math.round(raw)
  const pct = ((raw - 1) / (65535 - 1)) * 99 + 1
  return Math.min(100, Math.max(1, Math.round(pct)))
}

export function snapshotToCache(snap: DeviceSnapshot): CachedDeviceState {
  const brightRaw = num(snap.values.brightness)
  const ctRaw = num(
    snap.values['color-temperature'] ?? snap.values.color_temperature ?? snap.values.ct,
  )
  const pm = num(snap.values.pm2_5 ?? snap.values.pm25)
  const temperature = num(snap.values.temperature)
  const humidity = num(snap.values.relative_humidity ?? snap.values.humidity)
  const filter = num(snap.values.filter_life_level)
  const electricPower = num(snap.values['electric-power'] ?? snap.values.electric_power)
  const powerCostToday = num(snap.values.power_cost_today)
  const powerCostMonth = num(snap.values.power_cost_month)
  const delayOff = bool(snap.values['on-8'] ?? snap.values.on_8)
  const delayMinutes = num(snap.values.duration)
  const delayLeft = num(snap.values['left-time'] ?? snap.values.left_time)
  const timerOn = bool(snap.values.status)
  const timerDataRaw = snap.values['data-value'] ?? snap.values.data_value
  const timerData = timerDataRaw != null ? String(timerDataRaw) : undefined

  return {
    power: snap.switch?.value == null ? undefined : Boolean(snap.switch.value),
    switchName: snap.switch?.name ?? undefined,
    brightness: brightRawToUi(brightRaw),
    colorTemp:
      ctRaw != null && ctRaw > 0
        ? Math.min(6500, Math.max(2700, Math.round(ctRaw)))
        : undefined,
    mode: snap.values.mode != null ? String(snap.values.mode) : undefined,
    pm25: pm,
    temperature,
    humidity,
    filter,
    electricPower,
    powerCostToday,
    powerCostMonth,
    delayOff,
    delayMinutes,
    delayLeft,
    timerOn,
    timerData,
    updatedAt: Date.now(),
  }
}

export function cacheEquals(a?: CachedDeviceState, b?: CachedDeviceState): boolean {
  if (!a || !b) return false
  const keys: (keyof CachedDeviceState)[] = [
    'power',
    'brightness',
    'colorTemp',
    'mode',
    'pm25',
    'temperature',
    'humidity',
    'filter',
    'switchName',
    'electricPower',
    'powerCostToday',
    'powerCostMonth',
    'delayOff',
    'delayMinutes',
    'delayLeft',
    'timerOn',
    'timerData',
  ]
  return keys.every((k) => a[k] === b[k])
}

export function mergeCache(
  prev: CachedDeviceState | undefined,
  next: CachedDeviceState,
): CachedDeviceState {
  return {
    ...prev,
    ...Object.fromEntries(
      Object.entries(next).filter(([, v]) => v !== undefined),
    ),
    updatedAt: next.updatedAt,
  } as CachedDeviceState
}
