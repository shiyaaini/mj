import type { Device } from '@mi-home/shared'
import { bridgeApi } from '@/api/bridge'
import { cacheEquals, snapshotToCache } from '@/lib/deviceCache'
import { useAppStore } from '@/stores/appStore'
import type { PluginConfig } from '@/vite-env'

export type MiPluginDevice = {
  id: string
  name: string
  model: string
  status: string
  type: string
}

export type MiPluginOptions = {
  baseUrl?: string
  config?: PluginConfig
}

/**
 * Passed to React plugins as `miPlugin` prop (also `window.__miPlugin` while mounted).
 */
export type MiPluginApi = {
  device: MiPluginDevice
  /** Live attribute map from snapshot. */
  values: Record<string, unknown>
  /** Package config.json */
  config: PluginConfig
  /** HTTP base of the plugin folder (assets). */
  baseUrl: string
  /** Resolve a package-relative asset path to a fetchable URL. */
  assetUrl: (relativePath: string) => string
  setProp: (name: string, value: unknown) => Promise<void>
  setSwitch: (value: boolean) => Promise<void>
  runAction: (name: string, params?: unknown[]) => Promise<unknown>
  reload: () => Promise<void>
  toast: (message: string) => void
}

function joinAssetUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const rel = relativePath.replace(/^\/+/, '').replace(/\\/g, '/')
  if (!rel) return base
  return `${base}/${rel
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/')}`
}

export function createMiPluginApi(
  device: Device,
  onReload: () => Promise<void>,
  onChange?: () => void,
  options: MiPluginOptions = {},
): MiPluginApi {
  const notify = () => onChange?.()
  const baseUrl = options.baseUrl || ''
  const config = options.config || {
    id: device.model || 'plugin',
    match: device.model || '*',
  }

  const api: MiPluginApi = {
    device: {
      id: device.id,
      name: device.name || '',
      model: device.model || '',
      status: device.status,
      type: device.type,
    },
    values: {},
    config,
    baseUrl,
    assetUrl(relativePath: string) {
      return joinAssetUrl(api.baseUrl, relativePath)
    },
    async setProp(name: string, value: unknown) {
      const store = useAppStore.getState()
      if (store.dataSource !== 'live') {
        api.values[name] = value
        notify()
        return
      }
      await bridgeApi.setProp(device.id, name, value)
      api.values[name] = value
      notify()
    },
    async setSwitch(value: boolean) {
      const store = useAppStore.getState()
      if (store.dataSource !== 'live') {
        api.values.on = value
        store.rememberDeviceState(device.id, { power: value })
        notify()
        return
      }
      await bridgeApi.setSwitch(device.id, value)
      api.values.on = value
      store.rememberDeviceState(device.id, { power: value })
      notify()
    },
    async runAction(name: string, params: unknown[] = []) {
      if (useAppStore.getState().dataSource !== 'live') return null
      return bridgeApi.runDeviceAction(device.id, name, params)
    },
    async reload() {
      await onReload()
    },
    toast(message: string) {
      useAppStore.getState().showToast(message)
    },
  }

  return api
}

export async function hydratePluginValues(api: MiPluginApi, deviceId: string) {
  const store = useAppStore.getState()
  if (store.dataSource !== 'live') {
    const cache = store.deviceCache[deviceId]
    if (cache) {
      Object.assign(api.values, {
        on: cache.power,
        brightness: cache.brightness,
        'color-temperature': cache.colorTemp,
        mode: cache.mode,
        pm2_5: cache.pm25,
        temperature: cache.temperature,
        relative_humidity: cache.humidity,
      })
    }
    return
  }
  try {
    const snap = await bridgeApi.getSnapshot(deviceId)
    for (const k of Object.keys(api.values)) delete api.values[k]
    Object.assign(api.values, snap.values || {})
    if (snap.switch?.name && snap.switch.value != null) {
      api.values[snap.switch.name] = snap.switch.value
      if (snap.switch.name !== 'on') api.values.on = snap.switch.value
    }
    const next = snapshotToCache(snap)
    const prev = store.deviceCache[deviceId]
    if (!cacheEquals(prev, next)) {
      store.rememberDeviceState(deviceId, next)
    }
  } catch {
    /* keep previous values */
  }
}
