import { useEffect, useMemo, useRef, useState } from 'react'
import { DeviceCard } from '@/components/DeviceCard'
import { IconRefresh } from '@/components/Icons'
import {
  BUILTIN_FILTER_CATEGORIES,
  compareDevicesByModel,
  countDevicesByCategory,
  resolveDeviceCategoryId,
} from '@/lib/deviceMap'
import { CATEGORY_LABELS, ROOM_LABELS } from '@/labels'
import { useAppStore } from '@/stores/appStore'
import type { Device } from '@mi-home/shared'

function matchesQuery(device: Device, query: string, categoryId: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [
    device.name,
    device.nameKey,
    device.model,
    device.roomName,
    device.roomId,
    device.type,
    categoryId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

export function DevicesPage() {
  const devices = useAppStore((s) => s.devices)
  const customCategories = useAppStore((s) => s.customCategories)
  const addCustomCategory = useAppStore((s) => s.addCustomCategory)
  const removeCustomCategory = useAppStore((s) => s.removeCustomCategory)
  const roomFilter = useAppStore((s) => s.roomFilter)
  const setRoomFilter = useAppStore((s) => s.setRoomFilter)
  const rooms = useAppStore((s) => s.rooms)
  const dataSource = useAppStore((s) => s.dataSource)
  const syncing = useAppStore((s) => s.syncing)
  const syncFromBridge = useAppStore((s) => s.syncFromBridge)
  const showToast = useAppStore((s) => s.showToast)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [newKeyword, setNewKeyword] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const customDialogRef = useRef<HTMLDivElement>(null)

  const counts = useMemo(
    () => countDevicesByCategory(devices, customCategories),
    [devices, customCategories],
  )

  const statusCounts = useMemo(() => {
    let online = 0
    let offline = 0
    for (const d of devices) {
      if (d.status === 'online') online += 1
      else offline += 1
    }
    return { online, offline, all: devices.length }
  }, [devices])

  const filtered = useMemo(() => {
    return devices
      .filter((d) => {
        if (roomFilter !== 'all' && d.roomId !== roomFilter) return false
        if (statusFilter !== 'all' && d.status !== statusFilter) return false
        const catId = resolveDeviceCategoryId(d, customCategories)
        if (category !== 'all' && catId !== category) return false
        if (!matchesQuery(d, query, catId)) return false
        return true
      })
      .sort(compareDevicesByModel)
  }, [devices, roomFilter, category, statusFilter, query, customCategories])

  // Full sorted list kept mounted; filter only toggles visibility (icons stay warm)
  const sortedAll = useMemo(
    () => [...devices].sort(compareDevicesByModel),
    [devices],
  )
  const visibleIds = useMemo(() => new Set(filtered.map((d) => d.id)), [filtered])

  useEffect(() => {
    if (!filterOpen && !customOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (customOpen) setCustomOpen(false)
      else setFilterOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filterOpen, customOpen])

  const busy = syncing || refreshing

  const categoryLabel = (() => {
    if (category === 'all') return '全部类型'
    const custom = customCategories.find((c) => c.id === category)
    if (custom) return custom.label
    return CATEGORY_LABELS[category] || category
  })()

  const statusLabel =
    statusFilter === 'all'
      ? null
      : statusFilter === 'online'
        ? "在线"
        : "离线"

  const filterSummary = statusLabel ? `${categoryLabel} · ${statusLabel}` : categoryLabel

  const filterActive = category !== 'all' || statusFilter !== 'all'

  const pickCategory = (next: string) => {
    setCategory(next)
  }

  const pickStatus = (next: 'all' | 'online' | 'offline') => {
    setStatusFilter(next)
  }

  const handleRefresh = async () => {
    if (busy) return
    if (dataSource !== 'live') {
      showToast("已刷新")
      return
    }
    setRefreshing(true)
    try {
      const ok = await syncFromBridge()
      if (ok) showToast("已刷新")
    } finally {
      setRefreshing(false)
    }
  }

  const openCustomDialog = () => {
    setNewKeyword('')
    setNewLabel('')
    setCustomOpen(true)
  }

  const handleAddCustom = () => {
    const keyword = newKeyword.trim()
    const label = newLabel.trim() || keyword
    const ok = addCustomCategory(keyword, label)
    if (!ok) {
      showToast("关键字无效或已存在")
      return
    }
    setNewKeyword('')
    setNewLabel('')
    setCustomOpen(false)
    showToast("已添加自定义类型")
  }

  const handleRemoveCustom = (id: string) => {
    removeCustomCategory(id)
    if (category === id) setCategory('all')
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>设备</h1>
          <p>
            {`显示 ${filtered.length} / ${devices.length} 台`}
          </p>
        </div>
        <button
          type="button"
          className={`btn btn-ghost refresh-btn${busy ? ' spinning' : ''}`}
          disabled={busy}
          onClick={() => void handleRefresh()}
          title={busy ? "正在同步…" : "刷新"}
          aria-label={busy ? "正在同步…" : "刷新"}
        >
          <IconRefresh />
        </button>
      </header>

      <div className="device-toolbar">
        <label className="device-search">
          <span className="device-search-icon" aria-hidden>
            ⌕
          </span>
          <input
            type="search"
            value={query}
            placeholder="搜索名称、型号关键字…"
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              className="device-search-clear"
              onClick={() => setQuery('')}
              aria-label="取消"
            >
              ×
            </button>
          ) : null}
        </label>

        <button
          type="button"
          className={`device-filter-btn${filterActive ? ' active' : ''}`}
          onClick={() => setFilterOpen(true)}
        >
          <span>筛选</span>
          <strong>{filterSummary}</strong>
        </button>
      </div>

      <div className="room-tabs">
        {rooms.map((room) => (
          <button
            key={room.id}
            type="button"
            className={`room-tab${roomFilter === room.id ? ' active' : ''}`}
            onClick={() => setRoomFilter(room.id)}
          >
            {room.name || ROOM_LABELS[room.id] || room.nameKey || room.id}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="empty">
          {devices.length === 0 ? "暂无设备" : "没有符合条件的设备"}
        </p>
      ) : null}
      {sortedAll.length > 0 ? (
        <div className={`card-grid${filtered.length === 0 ? ' is-empty-filter' : ''}`}>
          {sortedAll.map((device) => {
            const hidden = !visibleIds.has(device.id)
            return (
              <div
                key={device.id}
                className={hidden ? 'device-card-slot is-filtered-out' : 'device-card-slot'}
                hidden={hidden}
              >
                <DeviceCard device={device} />
              </div>
            )
          })}
        </div>
      ) : null}

      {filterOpen ? (
        <div
          className="filter-overlay"
          role="presentation"
          onClick={() => setFilterOpen(false)}
        >
          <div
            ref={dialogRef}
            className="filter-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-filter-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="filter-dialog-head">
              <h2 id="device-filter-title">筛选设备</h2>
              <button
                type="button"
                className="filter-dialog-close"
                onClick={() => setFilterOpen(false)}
                aria-label="取消"
              >
                ×
              </button>
            </div>
            <div className="filter-dialog-body">
              <p className="filter-dialog-hint">可按在线状态和设备类型组合筛选</p>

              <div className="filter-section">
                <h3 className="filter-section-title">在线状态</h3>
                <div className="filter-grid filter-grid-status">
                  <button
                    type="button"
                    className={`filter-chip${statusFilter === 'all' ? ' active' : ''}`}
                    onClick={() => pickStatus('all')}
                  >
                    <span>全部状态</span>
                    <em>{statusCounts.all}</em>
                  </button>
                  <button
                    type="button"
                    className={`filter-chip${statusFilter === 'online' ? ' active' : ''}`}
                    onClick={() => pickStatus('online')}
                  >
                    <span>在线</span>
                    <em>{statusCounts.online}</em>
                  </button>
                  <button
                    type="button"
                    className={`filter-chip${statusFilter === 'offline' ? ' active' : ''}`}
                    onClick={() => pickStatus('offline')}
                  >
                    <span>离线</span>
                    <em>{statusCounts.offline}</em>
                  </button>
                </div>
              </div>

              <div className="filter-section">
                <h3 className="filter-section-title">设备类型</h3>
                <div className="filter-grid">
                  <button
                    type="button"
                    className={`filter-chip${category === 'all' ? ' active' : ''}`}
                    onClick={() => pickCategory('all')}
                  >
                    <span>全部类型</span>
                    <em>{devices.length}</em>
                  </button>

                  {BUILTIN_FILTER_CATEGORIES.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`filter-chip${category === id ? ' active' : ''}`}
                      onClick={() => pickCategory(id)}
                    >
                      <span>{CATEGORY_LABELS[id] || id}</span>
                      <em>{counts.get(id) || 0}</em>
                    </button>
                  ))}

                  {customCategories.map((rule) => (
                    <div
                      key={rule.id}
                      className={`filter-chip custom${category === rule.id ? ' active' : ''}`}
                    >
                      <button
                        type="button"
                        className="filter-chip-main"
                        onClick={() => pickCategory(rule.id)}
                      >
                        <span>{rule.label}</span>
                        <small>{rule.keyword}</small>
                        <em>{counts.get(rule.id) || 0}</em>
                      </button>
                      <button
                        type="button"
                        className="filter-chip-remove"
                        title="删除自定义类型"
                        onClick={() => handleRemoveCustom(rule.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}

                  <button
                    type="button"
                    className="filter-chip filter-chip-add"
                    onClick={openCustomDialog}
                  >
                    <span>+ 自定义</span>
                    <em>添加类型</em>
                  </button>
                </div>
              </div>
            </div>

            <div className="filter-dialog-footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setCategory('all')
                  setStatusFilter('all')
                }}
              >
                重置
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setFilterOpen(false)}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {customOpen ? (
        <div
          className="filter-overlay filter-overlay-top"
          role="presentation"
          onClick={() => setCustomOpen(false)}
        >
          <div
            ref={customDialogRef}
            className="filter-dialog custom-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-custom-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="filter-dialog-head">
              <h2 id="device-custom-title">添加自定义类型</h2>
              <button
                type="button"
                className="filter-dialog-close"
                onClick={() => setCustomOpen(false)}
                aria-label="取消"
              >
                ×
              </button>
            </div>
            <div className="filter-dialog-body">
              <p className="filter-dialog-hint">填写 model 中的关键字，以及要显示的类型名称</p>
              <form
                className="custom-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  handleAddCustom()
                }}
              >
                <label className="custom-field">
                  <span>关键字</span>
                  <input
                    type="text"
                    value={newKeyword}
                    placeholder="如 diffuser、abwheel"
                    onChange={(e) => setNewKeyword(e.target.value)}
                    autoComplete="off"
                    autoFocus
                  />
                </label>
                <label className="custom-field">
                  <span>类型名称</span>
                  <input
                    type="text"
                    value={newLabel}
                    placeholder="如 香薰机、健腹轮"
                    onChange={(e) => setNewLabel(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <div className="custom-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setCustomOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!newKeyword.trim()}
                  >
                    添加
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
