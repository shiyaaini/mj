import type { DeviceCapabilities, DevicePropMeta } from '@/api/bridge'
import { effectivePropRw } from '@/lib/propFormat'

export type CachedCapabilities = {
  caps: DeviceCapabilities
  updatedAt: number
}

function canRead(prop: DevicePropMeta) {
  return effectivePropRw(prop).includes('r')
}

export function valuesEqual(
  a: Record<string, unknown> = {},
  b: Record<string, unknown> = {},
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (String(a[k]) !== String(b[k])) return false
  }
  return true
}

export function schemaEqual(a?: DeviceCapabilities | null, b?: DeviceCapabilities | null): boolean {
  if (!a || !b) return false
  if (a.properties.length !== b.properties.length) return false
  if ((a.actions?.length || 0) !== (b.actions?.length || 0)) return false
  for (let i = 0; i < a.properties.length; i++) {
    const pa = a.properties[i]
    const pb = b.properties[i]
    if (pa.name !== pb.name || pa.type !== pb.type) return false
  }
  return true
}

const PRIORITY_PROP_NAMES = new Set([
  'on',
  'volume',
  'playing-state',
  'audio-id',
  'sleep-mode',
  'mute',
  'mute-2',
  'mute-4',
  'no-disturb',
  'brightness',
  'mode',
  'status',
  'battery-level',
  'temperature',
  'relative-humidity',
  'target-humidity',
])

export function readablePropNames(caps: DeviceCapabilities, limit = 24): string[] {
  const names: string[] = []
  for (const prop of caps.properties) {
    if (!canRead(prop)) continue
    if (/scene|fault|chip|delay|flex|manufacturer|firmware|serial/i.test(prop.name)) {
      continue
    }
    names.push(prop.name)
  }
  const preferred = names.filter(
    (n) =>
      n === 'on' ||
      n.startsWith('on-') ||
      n.startsWith('on_') ||
      PRIORITY_PROP_NAMES.has(n),
  )
  const rest = names.filter((n) => !preferred.includes(n))
  return [...preferred, ...rest].slice(0, limit)
}

export function mergeCapabilityValues(
  caps: DeviceCapabilities,
  values: Record<string, unknown>,
): DeviceCapabilities {
  return {
    ...caps,
    values: { ...caps.values, ...values },
  }
}
