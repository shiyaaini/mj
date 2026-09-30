import type { DevicePropMeta } from '@/api/bridge'

const HIDDEN_PROP_PATTERNS = [
  /scene/i,
  /delay/i,
  /flow/i,
  /gradual/i,
  /flex[-_]?switch/i,
  /nl[-_]?/i,
  /idle[-_]?time[-_]?power/i,
  /unix[-_]?time/i,
  /serial/i,
  /manufacturer/i,
  /firmware/i,
]

const SENTINEL_VALUES = new Set([
  -2147483648,
  2147483647,
  -1,
  4294967295,
])

export function cleanEnumLabel(text: string) {
  return text
    .replace(/\s*\/\s*.*$/, '')
    .replace(/\d{2,}$/g, '')
    .replace(/[_\-]+$/g, '')
    .trim()
}

/**
 * BLE / broken Specs sometimes return empty `rw` while still exposing controls.
 * Infer a usable access mask so generic UI can still render.
 */
export function effectivePropRw(prop: DevicePropMeta): string {
  const raw = Array.isArray(prop.rw) ? prop.rw.join('') : String(prop.rw || '')
  if (/[rw]/i.test(raw)) return raw.toLowerCase()

  const name = prop.name.toLowerCase()
  if (HIDDEN_PROP_PATTERNS.some((re) => re.test(name) || re.test(prop.desc || ''))) {
    return 'r'
  }
  if (Array.isArray(prop.value_list) && prop.value_list.length > 0) {
    return 'rw'
  }
  const range = Array.isArray(prop.range) ? prop.range : null
  if (range) {
    const min = Number(range[0])
    const max = Number(range[1])
    if (Number.isFinite(min) && Number.isFinite(max) && max - min > 0 && max - min <= 10000) {
      return 'rw'
    }
  }
  return 'r'
}

export function shouldShowAdjustProp(prop: DevicePropMeta) {
  const name = prop.name.toLowerCase()
  if (HIDDEN_PROP_PATTERNS.some((re) => re.test(name) || re.test(prop.desc || ''))) {
    return false
  }
  // Prefer common lighting / climate / diffuser controls
  if (
    /brightness|bright|ct|color[-_]?temp|humidity|fan|volume|level|fragrance|idle[-_]?time|^light$/.test(
      name,
    )
  ) {
    return true
  }
  // Keep short-named writable numbers with sane ranges
  const range = Array.isArray(prop.range) ? prop.range : null
  if (!range) return false
  const min = Number(range[0])
  const max = Number(range[1])
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false
  if (max - min > 100000) return false
  return max - min <= 10000
}

export interface SliderModel {
  min: number
  max: number
  step: number
  display: string
  unit?: string
  /** Map UI value -> device value */
  toDevice: (ui: number) => number
  /** Map device value -> UI value */
  toUi: (device: number) => number
}

export function buildSliderModel(prop: DevicePropMeta, rawValue: unknown): SliderModel | null {
  const range = Array.isArray(prop.range) ? prop.range.map(Number) : [0, 100, 1]
  let min = Number.isFinite(range[0]) ? range[0] : 0
  let max = Number.isFinite(range[1]) ? range[1] : 100
  let step = Number.isFinite(range[2]) && range[2] > 0 ? range[2] : 1
  const name = prop.name.toLowerCase()
  const raw = Number(rawValue)

  if (SENTINEL_VALUES.has(raw) || !Number.isFinite(raw)) {
    // still allow editing with default mid
  }

  // Brightness often uses 0~100, sometimes 1~100, rarely huge ints
  if (/brightness|bright$/.test(name) && !/scene/.test(name)) {
    if (max > 1000) {
      // Treat as 0-100 percentage mapped into device range
      return {
        min: 1,
        max: 100,
        step: 1,
        unit: '%',
        display: 'brightness',
        toDevice: (ui) => Math.round(min + ((ui - 1) / 99) * (max - min)),
        toUi: (device) => {
          if (!Number.isFinite(device) || SENTINEL_VALUES.has(device)) return 50
          const pct = ((device - min) / Math.max(max - min, 1)) * 99 + 1
          return Math.min(100, Math.max(1, Math.round(pct)))
        },
      }
    }
    return {
      min: min <= 1 ? Math.max(min, 0) : min,
      max: Math.min(max, 100),
      step: 1,
      unit: '%',
      display: 'brightness',
      toDevice: (ui) => ui,
      toUi: (device) => {
        if (!Number.isFinite(device) || SENTINEL_VALUES.has(device)) return 50
        return Math.min(100, Math.max(0, Math.round(device)))
      },
    }
  }

  // Color temperature in Kelvin
  if (/color[-_]?temp|ct$|colortemperature/.test(name) && !/scene/.test(name)) {
    if (max > 100000) {
      // weird scale, skip
      return null
    }
    const lo = min > 0 ? min : 2700
    const hi = max > lo ? max : 6500
    return {
      min: lo,
      max: hi,
      step: Math.max(10, step),
      unit: 'K',
      display: 'ct',
      toDevice: (ui) => ui,
      toUi: (device) => {
        if (!Number.isFinite(device) || SENTINEL_VALUES.has(device)) return Math.round((lo + hi) / 2)
        return Math.min(hi, Math.max(lo, Math.round(device)))
      },
    }
  }

  if (max - min > 100000) return null
  if (SENTINEL_VALUES.has(min) || SENTINEL_VALUES.has(max)) return null

  const unit = /humidity|percent|brightness|bright$/.test(name) ? '%' : undefined

  return {
    min,
    max,
    step: step || 1,
    unit,
    display: 'generic',
    toDevice: (ui) => ui,
    toUi: (device) => {
      if (!Number.isFinite(device) || SENTINEL_VALUES.has(device)) {
        return Math.round((min + max) / 2)
      }
      return Math.min(max, Math.max(min, device))
    },
  }
}

export function formatSliderValue(ui: number, model: SliderModel) {
  if (model.unit === '%') return `${ui}%`
  if (model.unit === 'K') return `${ui}K`
  return String(ui)
}

/** Resolve enum descriptions for status chips / displays. */
export function formatPropDisplayValue(prop: DevicePropMeta, value: unknown) {
  if (value === undefined || value === null) return '—'
  const list = prop.value_list
  if (Array.isArray(list) && list.length) {
    const hit = list.find((item) => String(item.value) === String(value))
    if (hit) return cleanEnumLabel(hit.description || String(hit.value))
  }
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF'
  return String(value)
}

/** Cached Spec with empty access flags needs a full refetch after Bridge gatt-access fix. */
export function schemaMissingAccess(caps?: DeviceCapabilitiesLike | null): boolean {
  if (!caps?.properties?.length) return false
  return caps.properties.every((p) => !/[rw]/i.test(String(Array.isArray(p.rw) ? p.rw.join('') : p.rw || '')))
}

type DeviceCapabilitiesLike = {
  properties: DevicePropMeta[]
}
