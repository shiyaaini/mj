import { useCallback, useEffect, useState } from 'react'
import type { PluginInfo } from '@/vite-env'
import { findPluginForModel } from './match'
import { isPluginEnabled } from './pluginPrefs'
import { pluginCacheKey, prefetchReactPlugin } from './runtime'

function warmupPlugins(list: PluginInfo[]) {
  for (const p of list) {
    prefetchReactPlugin(p.url, pluginCacheKey(p))
  }
}

export function usePluginsList() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    if (!window.miHome?.plugins) {
      setPlugins([])
      setLoaded(true)
      return
    }
    try {
      const list = await window.miHome.plugins.list()
      setPlugins(list)
      warmupPlugins(list)
    } catch {
      setPlugins([])
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { plugins, loaded, refresh }
}

export function useMatchedPlugin(model?: string | null) {
  const { plugins, loaded, refresh } = usePluginsList()
  const enabledPlugins = plugins.filter((p) => isPluginEnabled(p.fileName))
  const plugin = findPluginForModel(enabledPlugins, model)
  return { plugin, loaded, refresh, plugins }
}
