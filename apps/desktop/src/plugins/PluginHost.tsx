import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PluginInfo } from '@/vite-env'
import { useAppStore } from '@/stores/appStore'
import {
  isPluginEnabled,
  readEnabledMap,
  removePluginPref,
  setPluginEnabled,
} from './pluginPrefs'
import { mountReactPlugin, pluginCacheKey, unmountReactPlugin } from './runtime'
import './plugins.css'

type Props = {
  plugins: PluginInfo[]
  activeFileName: string | null
  onSelect: (fileName: string) => void
  onRemove: (fileName: string) => void
  onRemoveMany: (fileNames: string[]) => void
  onInstall: () => void
  onOpenDocs: () => void
  onRevealDir: () => void
  busy?: boolean
  hasPluginsApi?: boolean
}

type StatusFilter = 'all' | 'enabled' | 'disabled'
type SortKey = 'name' | 'mtime' | 'version'
type DetailTab = 'detail' | 'config' | 'preview'

const PAGE_SIZE = 8
const SPLIT_KEY = 'mi-home-plugin-split-pct'
const SPLIT_MIN = 28
const SPLIT_MAX = 72

function readSplitPct(): number {
  try {
    const n = Number(localStorage.getItem(SPLIT_KEY))
    if (Number.isFinite(n) && n >= SPLIT_MIN && n <= SPLIT_MAX) return n
  } catch {
    /* ignore */
  }
  return 48
}

function usageText(plugin: PluginInfo): string {
  const d = plugin.config.description
  if (typeof d === 'string' && d.trim()) return d.trim()
  return matchLabel(plugin)
}

function matchLabel(plugin: PluginInfo): string {
  const m = plugin.config?.match
  if (Array.isArray(m)) return m.join(', ')
  if (typeof m === 'string') return m
  return plugin.id
}

function displayName(plugin: PluginInfo): string {
  return plugin.config.name || plugin.id
}

function authorOf(plugin: PluginInfo): string {
  const a = plugin.config.author
  return typeof a === 'string' && a.trim() ? a.trim() : '本地'
}

function formatTime(ms: number): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return '—'
  }
}

function PlaceholderLogo({ name }: { name: string }) {
  const ch = (name.trim()[0] || 'P').toUpperCase()
  return (
    <span className="pm-logo-fallback" aria-hidden>
      {ch}
    </span>
  )
}

function UsageLine({
  text,
  onCopy,
  className,
}: {
  text: string
  onCopy: (text: string) => void
  className?: string
}) {
  return (
    <span className={`pm-usage${className ? ` ${className}` : ''}`}>
      <span className="pm-usage-text" title={text}>
        {text}
      </span>
      <button
        type="button"
        className="pm-copy-btn"
        title="复制使用说明"
        aria-label="复制使用说明"
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onCopy(text)
        }}
      >
        复制
      </button>
    </span>
  )
}

export function PluginHost({
  plugins,
  activeFileName,
  onSelect,
  onRemove,
  onRemoveMany,
  onInstall,
  onOpenDocs,
  onRevealDir,
  busy,
  hasPluginsApi,
}: Props) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(() =>
    readEnabledMap(),
  )
  const [tab, setTab] = useState<DetailTab>('detail')
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewMounting, setPreviewMounting] = useState(false)
  const [leftPct, setLeftPct] = useState(readSplitPct)
  const [dragging, setDragging] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const showToast = useAppStore((s) => s.showToast)

  const copyUsage = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        showToast('使用说明已复制')
      } catch {
        showToast('复制失败')
      }
    },
    [showToast],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const el = bodyRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width < 80) return
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct)))
    }
    const onUp = () => {
      setDragging(false)
      setLeftPct((cur) => {
        try {
          localStorage.setItem(SPLIT_KEY, String(cur))
        } catch {
          /* ignore */
        }
        return cur
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging])

  const active = plugins.find((p) => p.fileName === activeFileName) ?? null

  const enabledOf = useCallback(
    (fileName: string) => {
      if (fileName in enabledMap) return enabledMap[fileName] !== false
      return isPluginEnabled(fileName)
    },
    [enabledMap],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = plugins.filter((p) => {
      const on = enabledOf(p.fileName)
      if (statusFilter === 'enabled' && !on) return false
      if (statusFilter === 'disabled' && on) return false
      if (!q) return true
      const hay = [
        displayName(p),
        p.id,
        p.fileName,
        p.config.description || '',
        matchLabel(p),
        authorOf(p),
        p.config.version || '',
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })

    list = [...list].sort((a, b) => {
      if (sortKey === 'mtime') return b.mtimeMs - a.mtimeMs
      if (sortKey === 'version') {
        return String(b.config.version || '').localeCompare(
          String(a.config.version || ''),
          undefined,
          { numeric: true },
        )
      }
      return displayName(a).localeCompare(displayName(b), 'zh')
    })
    return list
  }, [plugins, query, statusFilter, sortKey, enabledOf])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  useEffect(() => {
    setPage(1)
  }, [query, statusFilter, sortKey])

  useEffect(() => {
    setSelected((prev) => {
      const next = new Set<string>()
      for (const id of prev) {
        if (plugins.some((p) => p.fileName === id)) next.add(id)
      }
      return next
    })
  }, [plugins])

  const toggleEnabled = (fileName: string, next: boolean) => {
    setPluginEnabled(fileName, next)
    setEnabledMap(readEnabledMap())
  }

  const pageAllSelected =
    pageItems.length > 0 && pageItems.every((p) => selected.has(p.fileName))

  const toggleSelectAllPage = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (pageAllSelected) {
        for (const p of pageItems) next.delete(p.fileName)
      } else {
        for (const p of pageItems) next.add(p.fileName)
      }
      return next
    })
  }

  const batchDisable = () => {
    for (const id of selected) toggleEnabled(id, false)
  }

  const batchEnable = () => {
    for (const id of selected) toggleEnabled(id, true)
  }

  const batchDelete = () => {
    if (!selected.size || busy) return
    const names = [...selected]
    setSelected(new Set())
    onRemoveMany(names)
    for (const n of names) removePluginPref(n)
  }

  const remountPreview = useCallback(
    async (plugin: PluginInfo | null) => {
      const el = previewRef.current
      if (!el) return
      if (!plugin) {
        unmountReactPlugin(el)
        setPreviewError(null)
        return
      }
      setPreviewMounting(true)
      setPreviewError(null)
      const styleScope = `preview-${plugin.fileName}`
      try {
        const mockDevice = {
          id: 'preview',
          name: displayName(plugin),
          model: matchLabel(plugin),
          status: 'online',
          type: 'light',
        }
        const values = { on: true, brightness: 60, 'color-temperature': 4000 }
        await mountReactPlugin(plugin.url, el, {
          scopeClass: 'react-plugin-root',
          styleScope,
          cacheKey: pluginCacheKey(plugin),
          props: {
            device: mockDevice,
            values,
            config: plugin.config,
            miPlugin: {
              config: plugin.config,
              baseUrl: plugin.baseUrl,
              assetUrl: (rel: string) => {
                const base = plugin.baseUrl.replace(/\/+$/, '')
                const path = String(rel || '')
                  .replace(/^\/+/, '')
                  .split('/')
                  .filter(Boolean)
                  .map(encodeURIComponent)
                  .join('/')
                return path ? `${base}/${path}` : base
              },
              values,
              setProp: async () => {},
              setSwitch: async () => {},
              runAction: async () => null,
              reload: async () => {},
              toast: () => {},
              device: mockDevice,
            },
          },
        })
      } catch (err) {
        unmountReactPlugin(el, styleScope)
        setPreviewError(err instanceof Error ? err.message : String(err))
      } finally {
        setPreviewMounting(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (tab !== 'preview') {
      if (previewRef.current) unmountReactPlugin(previewRef.current)
      return
    }
    void remountPreview(active)
    return () => {
      if (previewRef.current && activeFileName) {
        unmountReactPlugin(previewRef.current, `preview-${activeFileName}`)
      }
    }
  }, [tab, active?.url, active?.mtimeMs, active?.size, activeFileName, remountPreview])

  return (
    <div className="pm">
      <div className="pm-toolbar">
        <input
          className="pm-search"
          type="search"
          placeholder="搜索插件名称、关键词…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="pm-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="状态筛选"
        >
          <option value="all">全部状态</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已关闭</option>
        </select>
        <select
          className="pm-select"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          aria-label="排序"
        >
          <option value="name">按名称</option>
          <option value="mtime">按安装时间</option>
          <option value="version">按版本</option>
        </select>
        <button
          type="button"
          className="btn btn-primary pm-install"
          disabled={busy || !hasPluginsApi}
          onClick={onInstall}
        >
          {busy ? '正在安装…' : '+ 安装插件'}
        </button>
        <button
          type="button"
          className="btn btn-ghost pm-icon-btn"
          onClick={onOpenDocs}
          title="编写说明"
          aria-label="编写说明"
        >
          ?
        </button>
      </div>

      <div
        ref={bodyRef}
        className={`pm-body${dragging ? ' dragging' : ''}`}
        style={{ ['--pm-left' as string]: `${leftPct}%` }}
      >
        <section className="pm-list-panel panel">
          <div className="pm-list-head">
            <div>
              <h2>插件列表</h2>
              <p className="meta soft">共 {filtered.length} 个插件</p>
            </div>
            <div className="pm-batch">
              <label className="pm-check">
                <input
                  type="checkbox"
                  checked={pageAllSelected}
                  disabled={!pageItems.length}
                  onChange={toggleSelectAllPage}
                />
                全选
              </label>
              <details className="pm-batch-menu">
                <summary className="btn btn-ghost">批量操作</summary>
                <div className="pm-batch-pop">
                  <button type="button" disabled={!selected.size} onClick={batchEnable}>
                    启用所选
                  </button>
                  <button type="button" disabled={!selected.size} onClick={batchDisable}>
                    关闭所选
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={!selected.size || busy}
                    onClick={batchDelete}
                  >
                    删除所选
                  </button>
                </div>
              </details>
            </div>
          </div>

          {!plugins.length ? (
            <p className="meta soft pm-empty">
              {hasPluginsApi
                ? '尚未安装插件，点击右上角「安装插件」选择 zip（可多选）'
                : '请在 Electron 客户端中安装插件'}
            </p>
          ) : !filtered.length ? (
            <p className="meta soft pm-empty">没有符合条件的插件</p>
          ) : (
            <ul className="pm-list">
              {pageItems.map((p) => {
                const on = enabledOf(p.fileName)
                const activeRow = p.fileName === activeFileName
                return (
                  <li
                    key={p.fileName}
                    className={`pm-row${activeRow ? ' active' : ''}${on ? '' : ' off'}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.fileName)}
                      onChange={() => {
                        setSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(p.fileName)) next.delete(p.fileName)
                          else next.add(p.fileName)
                          return next
                        })
                      }}
                      aria-label={`选择 ${displayName(p)}`}
                    />
                    <div
                      className="pm-row-main"
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelect(p.fileName)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSelect(p.fileName)
                        }
                      }}
                    >
                      {p.logoUrl ? (
                        <img className="pm-logo" src={p.logoUrl} alt="" />
                      ) : (
                        <PlaceholderLogo name={displayName(p)} />
                      )}
                      <span className="pm-row-text">
                        <span className="pm-row-title">
                          <strong>{displayName(p)}</strong>
                          <span className={`pm-badge${on ? ' on' : ''}`}>
                            {on ? '已启用' : '已关闭'}
                          </span>
                        </span>
                        <UsageLine text={usageText(p)} onCopy={(t) => void copyUsage(t)} />
                        <span className="pm-row-meta">
                          v{p.config.version || '—'} · by {authorOf(p)}
                        </span>
                      </span>
                    </div>
                    <label className="pm-switch" title={on ? '关闭' : '启用'}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => toggleEnabled(p.fileName, e.target.checked)}
                      />
                      <span />
                    </label>
                  </li>
                )
              })}
            </ul>
          )}

          {filtered.length > PAGE_SIZE ? (
            <div className="pm-pager">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <span className="meta">
                {safePage} / {pageCount}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={safePage >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              >
                下一页
              </button>
            </div>
          ) : null}
        </section>

        <div
          className="pm-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(leftPct)}
          aria-label="拖拽调整列表与详情宽度"
          onPointerDown={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
        />

        <section className="pm-detail-panel panel">
          {!active ? (
            <p className="meta soft pm-empty">选择左侧插件查看详情</p>
          ) : (
            <>
              <div className="pm-tabs" role="tablist">
                {(
                  [
                    ['detail', '插件详情'],
                    ['config', '配置选项'],
                    ['preview', '预览'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    className={`pm-tab${tab === id ? ' active' : ''}`}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="pm-detail-summary">
                {active.logoUrl ? (
                  <img className="pm-logo lg" src={active.logoUrl} alt="" />
                ) : (
                  <PlaceholderLogo name={displayName(active)} />
                )}
                <div className="pm-detail-summary-text">
                  <div className="pm-row-title">
                    <h2>{displayName(active)}</h2>
                    <span
                      className={`pm-badge${enabledOf(active.fileName) ? ' on' : ''}`}
                    >
                      {enabledOf(active.fileName) ? '已启用' : '已关闭'}
                    </span>
                  </div>
                  <UsageLine
                    className="pm-usage-detail"
                    text={active.config.description || '暂无描述'}
                    onCopy={(t) => void copyUsage(t)}
                  />
                  <p className="pm-row-meta">
                    v{active.config.version || '—'} · by {authorOf(active)} ·{' '}
                    {formatTime(active.mtimeMs)}
                  </p>
                  <div className="pm-tags">
                    <span className="pm-tag">{active.kind === 'legacy' ? '旧版单文件' : 'zip 包'}</span>
                    <span className="pm-tag">{matchLabel(active)}</span>
                  </div>
                </div>
              </div>

              <div className="pm-ops">
                <button
                  type="button"
                  className="pm-op on"
                  disabled={enabledOf(active.fileName)}
                  onClick={() => toggleEnabled(active.fileName, true)}
                >
                  启用
                </button>
                <button
                  type="button"
                  className="pm-op"
                  disabled={!enabledOf(active.fileName)}
                  onClick={() => toggleEnabled(active.fileName, false)}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className="pm-op cfg"
                  disabled={!hasPluginsApi}
                  onClick={onRevealDir}
                >
                  打开目录
                </button>
                <button
                  type="button"
                  className="pm-op danger"
                  disabled={busy}
                  onClick={() => {
                    removePluginPref(active.fileName)
                    onRemove(active.fileName)
                  }}
                >
                  删除
                </button>
              </div>

              {tab === 'detail' ? (
                <div className="pm-detail-body">
                  <h3>详细信息</h3>
                  <dl className="pm-dl">
                    <div>
                      <dt>插件名称</dt>
                      <dd>{displayName(active)}</dd>
                    </div>
                    <div>
                      <dt>ID / 目录</dt>
                      <dd>
                        <code>{active.fileName}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>版本</dt>
                      <dd>{active.config.version || '—'}</dd>
                    </div>
                    <div>
                      <dt>作者</dt>
                      <dd>{authorOf(active)}</dd>
                    </div>
                    <div>
                      <dt>匹配 model</dt>
                      <dd>
                        <code>{matchLabel(active)}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>安装时间</dt>
                      <dd>{formatTime(active.mtimeMs)}</dd>
                    </div>
                    <div>
                      <dt>体积</dt>
                      <dd>
                        {active.size > 1024
                          ? `${(active.size / 1024).toFixed(1)} KB`
                          : `${active.size} B`}
                      </dd>
                    </div>
                  </dl>
                  <h3>插件描述</h3>
                  <UsageLine
                    className="pm-usage-block"
                    text={
                      active.config.description ||
                      '该插件未填写 description。可在 config.json 中补充。'
                    }
                    onCopy={(t) => void copyUsage(t)}
                  />
                </div>
              ) : null}

              {tab === 'config' ? (
                <div className="pm-detail-body">
                  <h3>config.json</h3>
                  <pre className="plugin-docs-code">
                    <code>{JSON.stringify(active.config, null, 2)}</code>
                  </pre>
                  <p className="meta soft">
                    修改请到插件目录编辑后重新打包安装（同 id 会覆盖）。
                  </p>
                </div>
              ) : null}

              {tab === 'preview' ? (
                <div className="pm-detail-body">
                  <div className="plugins-preview-head">
                    <h3>运行预览</h3>
                    {previewMounting ? <span className="meta">加载中…</span> : null}
                  </div>
                  {previewError ? (
                    <p className="plugin-error">{previewError}</p>
                  ) : null}
                  <div
                    ref={previewRef}
                    className="react-plugin-root plugin-container pm-preview-host"
                  />
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
