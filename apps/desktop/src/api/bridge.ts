const DEFAULT_BASE = 'http://127.0.0.1:8787'

export type BridgeMode = 'live' | 'mock'

export interface HealthResponse {
  status: string
  mode: BridgeMode
  authenticated: boolean
  version: string
}

export interface AuthStatus {
  authenticated: boolean
  user_id?: string | null
  status: 'idle' | 'pending' | 'success' | 'error'
  message?: string | null
  qr_image_url?: string | null
  login_url?: string | null
}

export interface UserProfile {
  authenticated: boolean
  mode: BridgeMode
  user_id?: string | null
  display_name?: string | null
  nickname?: string | null
  avatar_url?: string | null
  home_name?: string | null
  home_count: number
  device_count: number
  scene_count: number
  login_time?: number | null
  expire_time?: number | null
}

export interface BridgeDevice {
  id: string
  name: string
  model: string
  online: boolean
  home_id?: string | null
  room_id?: string | null
  /** Relative Bridge path, e.g. /models/{model}/icon */
  icon_url?: string | null
  raw?: {
    _room_name?: string | null
    [key: string]: unknown
  }
}

export interface BridgeScene {
  id: string
  name: string
  home_id?: string | null
}

export interface BridgeRoom {
  id?: string | number
  roomId?: string | number
  name?: string
  /** Device ids belonging to this room (Xiaomi often omits roomId on devices). */
  dids?: Array<string | number>
  [key: string]: unknown
}

export interface BridgeHome {
  id: string
  name: string
  rooms: BridgeRoom[]
  raw?: Record<string, unknown>
}

export class BridgeError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

type UnauthorizedHandler = () => void

let unauthorizedHandler: UnauthorizedHandler | null = null
let unauthorizedNotified = false

/** Register once (e.g. from App). Called on Bridge 401 outside /auth/*. */
export function setBridgeUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  unauthorizedHandler = handler
  unauthorizedNotified = false
}

function notifyUnauthorized() {
  if (unauthorizedNotified) return
  unauthorizedNotified = true
  try {
    unauthorizedHandler?.()
  } finally {
    // allow a later re-login session to notify again
    window.setTimeout(() => {
      unauthorizedNotified = false
    }, 1500)
  }
}

/** Reset after successful login so a future expiry can notify again immediately. */
export function resetBridgeUnauthorizedGuard() {
  unauthorizedNotified = false
}

function formatBridgeDetail(detail: unknown, fallback: string): string {
  if (detail == null || detail === '') return fallback
  if (typeof detail === 'string') return detail
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail)
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => formatBridgeDetail(item, '')).filter(Boolean)
    return parts.length ? parts.join('; ') : fallback
  }
  if (typeof detail === 'object') {
    const o = detail as Record<string, unknown>
    if (typeof o.msg === 'string') return o.msg
    if (typeof o.message === 'string') return o.message
    if (typeof o.detail === 'string') return o.detail
    try {
      return JSON.stringify(detail)
    } catch {
      return fallback
    }
  }
  return fallback
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = import.meta.env.VITE_BRIDGE_URL || DEFAULT_BASE
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    })
  } catch {
    throw new BridgeError('Bridge unreachable. Start apps/bridge first.', 0)
  }

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      notifyUnauthorized()
    }
    let detail = res.statusText || `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { detail?: unknown }
      detail = formatBridgeDetail(body.detail, detail)
    } catch {
      /* ignore */
    }
    throw new BridgeError(detail, res.status)
  }

  return (await res.json()) as T
}

/** Turn Bridge-relative paths into absolute URLs for <img src>. */
export function resolveBridgeAssetUrl(path?: string | null): string | undefined {
  if (!path) return undefined
  if (/^https?:\/\//i.test(path)) return path
  const base = (import.meta.env.VITE_BRIDGE_URL || DEFAULT_BASE).replace(/\/$/, '')
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`
}

/** Bridge base URL (no trailing slash). */
export function getBridgeBaseUrl(): string {
  return (import.meta.env.VITE_BRIDGE_URL || DEFAULT_BASE).replace(/\/$/, '')
}

/** FastAPI Swagger UI. */
export function getBridgeSwaggerUrl(): string {
  return `${getBridgeBaseUrl()}/docs`
}

/** FastAPI ReDoc. */
export function getBridgeRedocUrl(): string {
  return `${getBridgeBaseUrl()}/redoc`
}

export interface QrLoginStartResult {
  status: 'authenticated' | 'pending' | 'error'
  message: string
  qr_image_url?: string | null
  login_url?: string | null
}

export const bridgeApi = {
  health: () => request<HealthResponse>('/health'),
  authStatus: () => request<AuthStatus>('/auth/status'),
  startQrLogin: () =>
    request<QrLoginStartResult>('/auth/qr/start', {
      method: 'POST',
    }),
  qrStatus: () => request<AuthStatus>('/auth/qr/status'),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  getProfile: () => request<UserProfile>('/auth/profile'),
  listHomes: () => request<{ homes: BridgeHome[] }>('/homes'),
  listDevices: () => request<{ devices: BridgeDevice[] }>('/devices'),
  listScenes: () => request<{ scenes: BridgeScene[] }>('/scenes'),
  runScene: (sceneId: string, homeId?: string) =>
    request<{ ok: boolean }>(`/scenes/${encodeURIComponent(sceneId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ home_id: homeId ?? null }),
    }),
  setProp: (did: string, name: string, value: unknown) =>
    request<{ ok: boolean }>(`/devices/${encodeURIComponent(did)}/props`, {
      method: 'PUT',
      body: JSON.stringify({ name, value }),
    }),
  getProps: (did: string, names: string[]) =>
    request<{ props: Record<string, unknown> }>(
      `/devices/${encodeURIComponent(did)}/props`,
      {
        method: 'POST',
        body: JSON.stringify({ names }),
      },
    ),
  getCapabilities: (did: string, includeValues = true) =>
    request<DeviceCapabilities>(
      `/devices/${encodeURIComponent(did)}/capabilities?include_values=${includeValues ? 'true' : 'false'}`,
    ),
  getSnapshot: (did: string) =>
    request<DeviceSnapshot>(`/devices/${encodeURIComponent(did)}/snapshot`),
  getSwitch: (did: string) =>
    request<{ name: string | null; value: boolean | null }>(
      `/devices/${encodeURIComponent(did)}/switch`,
    ),
  setSwitch: (did: string, value: boolean) =>
    request<{ ok: boolean; name: string; value: boolean }>(
      `/devices/${encodeURIComponent(did)}/switch`,
      {
        method: 'PUT',
        body: JSON.stringify({ value }),
      },
    ),
  runDeviceAction: (did: string, name: string, params: unknown[] = []) =>
    request<{ ok: boolean }>(`/devices/${encodeURIComponent(did)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ name, params }),
    }),
  getScaleHistory: (did: string, opts?: { model?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.model) q.set('model', opts.model)
    if (opts?.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return request<ScaleHistoryResponse>(
      `/devices/${encodeURIComponent(did)}/scale/history${qs ? `?${qs}` : ''}`,
    )
  },
  getAbwheelHistory: (
    did: string,
    opts?: { model?: string; days?: number; limit?: number },
  ) => {
    const q = new URLSearchParams()
    if (opts?.model) q.set('model', opts.model)
    if (opts?.days) q.set('days', String(opts.days))
    if (opts?.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return request<AbwheelHistoryResponse>(
      `/devices/${encodeURIComponent(did)}/abwheel/history${qs ? `?${qs}` : ''}`,
    )
  },
  getAbwheelPeriod: (
    did: string,
    opts: {
      period: 'week' | 'month' | 'year'
      offset?: number
      model?: string
    },
  ) => {
    const q = new URLSearchParams()
    q.set('period', opts.period)
    if (opts.offset != null) q.set('offset', String(opts.offset))
    if (opts.model) q.set('model', opts.model)
    return request<AbwheelPeriodResponse>(
      `/devices/${encodeURIComponent(did)}/abwheel/period?${q.toString()}`,
    )
  },
  getPcbootOpLogs: (
    did: string,
    opts?: { model?: string; days?: number; limit?: number },
  ) => {
    const q = new URLSearchParams()
    if (opts?.model) q.set('model', opts.model)
    if (opts?.days) q.set('days', String(opts.days))
    if (opts?.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return request<PcbootOpLogsResponse>(
      `/devices/${encodeURIComponent(did)}/pcboot/logs${qs ? `?${qs}` : ''}`,
    )
  },
  getSpeakerNowPlaying: (did: string) =>
    request<SpeakerNowPlaying>(
      `/devices/${encodeURIComponent(did)}/speaker/now-playing`,
    ),
  getPlugPowerHistory: (
    did: string,
    opts?: { period?: PlugPowerPeriod; offset?: number },
  ) => {
    const q = new URLSearchParams()
    if (opts?.period) q.set('period', opts.period)
    if (opts?.offset != null) q.set('offset', String(opts.offset))
    const qs = q.toString()
    return request<PlugPowerHistory>(
      `/devices/${encodeURIComponent(did)}/power/history${qs ? `?${qs}` : ''}`,
    )
  },
  /** Download / refresh product icons from home.miot-spec.com */
  syncModelIcons: (opts?: { models?: string[]; force?: boolean }) =>
    request<{ ok: string[]; failed: string[]; count: number }>('/models/icons/sync', {
      method: 'POST',
      body: JSON.stringify({
        models: opts?.models ?? [],
        force: Boolean(opts?.force),
      }),
    }),
  getModelProduct: (model: string, refresh = false) =>
    request<ModelProduct>(
      `/models/${encodeURIComponent(model)}/product${refresh ? '?refresh=true' : ''}`,
    ),
  /** Crawl home.miot-spec.com and download icons + Spec presets (background job) */
  startCatalogSync: (opts?: {
    icons?: boolean
    specs?: boolean
    force?: boolean
    models?: string[]
  }) =>
    request<{ started: boolean; message: string; status: CatalogSyncStatus }>('/catalog/sync', {
      method: 'POST',
      body: JSON.stringify({
        icons: opts?.icons ?? true,
        specs: opts?.specs ?? true,
        force: Boolean(opts?.force),
        models: opts?.models ?? [],
      }),
    }),
  getCatalogStatus: () => request<CatalogSyncStatus>('/catalog/status'),
  listCatalogProducts: (opts?: {
    q?: string
    category?: string
    limit?: number
    offset?: number
  }) => {
    const q = new URLSearchParams()
    if (opts?.q) q.set('q', opts.q)
    if (opts?.category) q.set('category', opts.category)
    if (opts?.limit != null) q.set('limit', String(opts.limit))
    if (opts?.offset != null) q.set('offset', String(opts.offset))
    const qs = q.toString()
    return request<CatalogProductsResponse>(`/catalog/products${qs ? `?${qs}` : ''}`)
  },
}

export type PlugPowerPeriod = 'week' | 'month' | 'year'

export interface ModelProduct {
  model: string
  name: string
  brand: string
  icon: string
  icon_url?: string | null
  href: string
  plugin_download_href: string
  source_url: string
  updated_at?: number | null
  cached: boolean
}

export interface CatalogSyncStatus {
  running: boolean
  phase: string
  message: string
  progress: number
  total: number
  icons_ok: number
  icons_failed: number
  specs_ok: number
  specs_failed: number
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}

export interface CatalogProductsResponse {
  total: number
  offset: number
  limit: number
  products: {
    model: string
    name?: string
    brand?: string
    category?: string
    icon?: string
    icon_url?: string | null
    spec_cached?: boolean
  }[]
  index_updated_at?: number
  categories: { slug: string; label: string; href?: string }[]
}

export interface PlugPowerPoint {
  time: number
  label: string
  value: number
}

export interface PlugPowerHistory {
  did: string
  period: PlugPowerPeriod
  offset: number
  label: string
  start: number
  end: number
  unit: string
  total: number
  points: PlugPowerPoint[]
  count: number
}

export interface ScaleRecord {
  did: string
  model: string
  createTime: number
  weight: number
  bmi?: number | null
  bodyFat?: number | null
  muscleMass?: number | null
  bodyWater?: number | null
  boneMass?: number | null
  visceralFat?: number | null
  proteinMass?: number | null
  proteinPercent?: number | null
  skeletalMuscle?: number | null
  bodyScore?: number | null
  metabolicAge?: number | null
  bmr?: number | null
  heartRate?: number | null
  idealWeight?: number | null
  userName?: string | null
  height?: number | null
  reportFrom?: string | null
}

export interface ScaleHistoryResponse {
  did: string
  model: string
  latest: ScaleRecord | null
  records: ScaleRecord[]
  count: number
}

export interface AbwheelRecord {
  id: string
  did: string
  startTime: number
  endTime?: number | null
  durationSec?: number | null
  count?: number | null
  calories?: number | null
  category?: string | null
  title?: string | null
}

export interface AbwheelSummary {
  weekSessions: number
  weekCount?: number | null
  weekCalories?: number | null
  weekDurationSec?: number | null
  monthSessions?: number
  monthCount?: number | null
  monthCalories?: number | null
  monthDurationSec?: number | null
  yearSessions?: number
  yearCount?: number | null
  yearCalories?: number | null
  yearDurationSec?: number | null
  totalSessions?: number | null
  totalCount?: number | null
  totalCalories?: number | null
  totalDurationSec?: number | null
  earliestTime?: number | null
}

export interface AbwheelTrendPoint {
  date: number
  count: number
  calories: number
  durationSec: number
}

export interface AbwheelTrends {
  week: AbwheelTrendPoint[]
  month: AbwheelTrendPoint[]
  year: AbwheelTrendPoint[]
}

export interface AbwheelTotals {
  count?: number | null
  calories?: number | null
  durationSec?: number | null
  earliestTime?: number | null
  bestCount?: AbwheelRecord | null
  bestCalories?: AbwheelRecord | null
  bestDuration?: AbwheelRecord | null
}

export interface AbwheelHistoryResponse {
  did: string
  model: string
  source?: string
  latest: AbwheelRecord | null
  records: AbwheelRecord[]
  count: number
  summary?: AbwheelSummary
  trends?: AbwheelTrends
  totals?: AbwheelTotals
}

export interface AbwheelPeriodResponse {
  did: string
  model: string
  period: 'week' | 'month' | 'year'
  offset: number
  label: string
  startTime: number
  endTime: number
  summary: {
    count?: number | null
    calories?: number | null
    durationSec?: number | null
  }
  points: AbwheelTrendPoint[]
}

export interface PcbootOpLogRecord {
  id: string
  did: string
  at: number
  code?: number | null
  key: string
  title: string
  source?: string
}

export interface PcbootOpLogsResponse {
  did: string
  model: string
  source?: string
  key?: string
  records: PcbootOpLogRecord[]
  count: number
}

export interface SpeakerNowPlaying {
  did: string
  available: boolean
  reason?: string | null
  source?: string
  status?: number | null
  playing?: boolean
  paused?: boolean
  state?: string | null
  volume?: number | null
  audioId?: string | null
  title?: string | null
  artist?: string | null
  album?: string | null
  coverUrl?: string | null
  durationMs?: number | null
  positionMs?: number | null
  cpName?: string | null
  hardware?: string | null
  presence?: string | null
  resolveError?: string | null
}

export interface DeviceSnapshot {
  did: string
  name?: string | null
  model?: string | null
  kind: string
  switch: { name: string | null; value: boolean | null }
  values: Record<string, unknown>
}

export interface DevicePropMeta {
  name: string
  desc: string
  type: string
  rw: string[] | string
  range?: number[] | null
  value_list?: { value: number | string; description: string }[] | null
}

export interface DeviceCapabilities {
  did: string
  name?: string | null
  model?: string | null
  properties: DevicePropMeta[]
  actions: {
    name: string
    desc: string
    siid?: number
    aiid?: number
    in?: { piid: number; name: string; desc: string; format: string; default: unknown }[]
  }[]
  values: Record<string, unknown>
}
