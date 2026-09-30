import { useCallback, useEffect, useRef, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { createMiPluginApi, hydratePluginValues } from './miPluginApi'
import {
  mountReactPlugin,
  pluginCacheKey,
  unmountReactPlugin,
  type MountReactPluginHandle,
} from './runtime'
import type { PluginInfo } from '@/vite-env'
import './plugins.css'

type Props = {
  device: Device
  plugin: PluginInfo
  refreshToken?: number
}

declare global {
  interface Window {
    __miPlugin?: unknown
  }
}

function toPluginDevice(device: Device) {
  return {
    id: device.id,
    name: device.name || '',
    model: device.model || '',
    status: device.status,
    type: device.type,
  }
}

export function PluginDetail({ device, plugin, refreshToken = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<ReturnType<typeof createMiPluginApi> | null>(null)
  const handleRef = useRef<MountReactPluginHandle | null>(null)
  const deviceRef = useRef(device)
  const mountEpochRef = useRef(0)
  deviceRef.current = device
  const [error, setError] = useState<string | null>(null)
  const [mounting, setMounting] = useState(true)

  const pushProps = useCallback(() => {
    const api = apiRef.current
    const handle = handleRef.current
    if (!api || !handle) return
    api.device = toPluginDevice(deviceRef.current)
    handle.update({
      device: api.device,
      values: { ...api.values },
      config: api.config,
      miPlugin: api,
    })
  }, [])

  const reloadValues = useCallback(async () => {
    const api = apiRef.current
    if (!api) return
    const epoch = mountEpochRef.current
    await hydratePluginValues(api, deviceRef.current.id)
    if (epoch !== mountEpochRef.current || apiRef.current !== api) return
    pushProps()
  }, [pushProps])

  // Remount only when device id or plugin file changes — not on every store device object churn.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const epoch = ++mountEpochRef.current
    const deviceId = device.id
    const pluginUrl = plugin.url
    const cacheKey = pluginCacheKey(plugin)

    const run = async () => {
      setMounting(true)
      setError(null)
      try {
        const api = createMiPluginApi(deviceRef.current, reloadValues, pushProps, {
          baseUrl: plugin.baseUrl,
          config: plugin.config,
        })
        apiRef.current = api
        window.__miPlugin = api

        const mountPromise = mountReactPlugin(pluginUrl, el, {
          scopeClass: 'react-plugin-root',
          styleScope: `detail-${deviceId}`,
          cacheKey,
          props: {
            device: api.device,
            values: { ...api.values },
            config: api.config,
            miPlugin: api,
          },
        })

        await hydratePluginValues(api, deviceId)
        if (epoch !== mountEpochRef.current) {
          const handle = await mountPromise.catch(() => null)
          handle?.unmount()
          return
        }

        const handle = await mountPromise
        if (epoch !== mountEpochRef.current) {
          handle.unmount()
          return
        }

        handleRef.current = handle
        pushProps()
      } catch (err) {
        if (epoch === mountEpochRef.current) {
          setError(err instanceof Error ? err.message : String(err))
          handleRef.current = null
          unmountReactPlugin(el, `detail-${deviceId}`)
        }
      } finally {
        if (epoch === mountEpochRef.current) setMounting(false)
      }
    }

    void run()

    return () => {
      mountEpochRef.current += 1
      if (window.__miPlugin === apiRef.current) delete window.__miPlugin
      apiRef.current = null
      handleRef.current = null
      unmountReactPlugin(el, `detail-${deviceId}`)
    }
  }, [device.id, plugin.url, plugin.baseUrl, plugin.mtimeMs, plugin.size, reloadValues, pushProps])

  useEffect(() => {
    if (mounting) return
    pushProps()
  }, [device.name, device.status, device.model, device.type, mounting, pushProps])

  useEffect(() => {
    if (refreshToken <= 0 || mounting) return
    void reloadValues()
  }, [refreshToken, mounting, reloadValues])

  return (
    <div className="plugin-detail">
      {mounting ? <p className="meta soft">插件加载中…</p> : null}
      {error ? <p className="plugin-error">{error}</p> : null}
      <div
        id="plugin-container"
        ref={containerRef}
        className="react-plugin-root plugin-container plugin-detail-host"
      />
    </div>
  )
}
