import { useCallback, useEffect, useState } from 'react'
import { PluginDocsDialog } from '@/plugins/PluginDocsDialog'
import { PluginHost } from '@/plugins/PluginHost'
import { removePluginPref } from '@/plugins/pluginPrefs'
import {
  invalidatePluginCache,
  pluginCacheKey,
  prefetchReactPlugin,
} from '@/plugins/runtime'
import { useAppStore } from '@/stores/appStore'
import type { PluginInfo } from '@/vite-env'

export function TemplatesPage() {
  const showToast = useAppStore((s) => s.showToast)

  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [activePlugin, setActivePlugin] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [docsOpen, setDocsOpen] = useState(false)
  const hasPluginsApi = Boolean(window.miHome?.plugins)

  const refreshPlugins = useCallback(async () => {
    if (!window.miHome?.plugins) {
      setPlugins([])
      return
    }
    const list = await window.miHome.plugins.list()
    setPlugins(list)
    for (const p of list) {
      prefetchReactPlugin(p.url, pluginCacheKey(p))
    }
    setActivePlugin((cur) => {
      if (cur && list.some((p) => p.fileName === cur)) return cur
      return list[0]?.fileName ?? null
    })
  }, [])

  useEffect(() => {
    void refreshPlugins()
  }, [refreshPlugins])

  const onPickPlugin = async () => {
    if (!window.miHome?.plugins || busy) return
    setBusy(true)
    try {
      const result = await window.miHome.plugins.pickAndInstall()
      if (result.ok === false) {
        if (!result.canceled) {
          showToast(result.error || '插件安装失败')
        }
        return
      }
      for (const p of result.plugins) {
        invalidatePluginCache(p.fileName)
      }
      await refreshPlugins()
      setActivePlugin(result.plugins[0]?.fileName ?? null)
      const n = result.plugins.length
      const failN = result.failed?.length ?? 0
      if (failN) {
        showToast(`已安装 ${n} 个，失败 ${failN} 个`)
      } else {
        showToast(
          n === 1
            ? `已安装插件：${result.plugins[0].config.name || result.plugins[0].id}`
            : `已安装 ${n} 个插件`,
        )
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '插件安装失败')
    } finally {
      setBusy(false)
    }
  }

  const onRemovePlugin = async (fileName: string) => {
    if (!window.miHome?.plugins || busy) return
    setBusy(true)
    try {
      await window.miHome.plugins.remove(fileName)
      invalidatePluginCache(fileName)
      removePluginPref(fileName)
      if (activePlugin === fileName) setActivePlugin(null)
      await refreshPlugins()
      showToast(`已删除插件：${fileName}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除插件失败')
    } finally {
      setBusy(false)
    }
  }

  const onRemoveMany = async (fileNames: string[]) => {
    if (!window.miHome?.plugins || busy || !fileNames.length) return
    setBusy(true)
    try {
      let ok = 0
      for (const name of fileNames) {
        try {
          await window.miHome.plugins.remove(name)
          invalidatePluginCache(name)
          removePluginPref(name)
          ok += 1
        } catch {
          /* continue */
        }
      }
      if (activePlugin && fileNames.includes(activePlugin)) setActivePlugin(null)
      await refreshPlugins()
      showToast(`已删除 ${ok} 个插件`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '批量删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="templates-page">
      <header className="page-header">
        <div>
          <h1>插件</h1>
          <p>管理本地 zip 插件包：安装、启停、匹配设备详情</p>
        </div>
      </header>

      <PluginHost
        plugins={plugins}
        activeFileName={activePlugin}
        onSelect={setActivePlugin}
        onRemove={(name) => void onRemovePlugin(name)}
        onRemoveMany={(names) => void onRemoveMany(names)}
        onInstall={() => void onPickPlugin()}
        onOpenDocs={() => setDocsOpen(true)}
        onRevealDir={() => void window.miHome?.plugins?.revealDir()}
        busy={busy}
        hasPluginsApi={hasPluginsApi}
      />

      <PluginDocsDialog open={docsOpen} onClose={() => setDocsOpen(false)} />
    </div>
  )
}
