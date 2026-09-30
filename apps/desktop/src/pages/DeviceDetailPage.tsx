import { useEffect, useRef, useState } from 'react'
import { IconRefresh } from '@/components/Icons'
import { useAppStore } from '@/stores/appStore'
import {
  AbWheelDetail,
  AcDetail,
  CameraDetail,
  DehumidifierDetail,
  GenericDetail,
  LightDetail,
  LockDetail,
  MassagerDetail,
  PcBootDetail,
  PlugDetail,
  PurifierDetail,
  ScaleDetail,
  SpeakerDetail,
} from '@/devices'
import { isPcBootDevice } from '@/lib/deviceMap'
import { PluginDetail } from '@/plugins/PluginDetail'
import { useMatchedPlugin } from '@/plugins/usePlugins'

export function DeviceDetailDialog() {
  const id = useAppStore((s) => s.detailDeviceId)
  const closeDeviceDetail = useAppStore((s) => s.closeDeviceDetail)
  const device = useAppStore((s) => (id ? s.devices.find((d) => d.id === id) : undefined))
  const refreshDeviceDetail = useAppStore((s) => s.refreshDeviceDetail)
  const refreshDeviceSnapshot = useAppStore((s) => s.refreshDeviceSnapshot)
  const refreshDeviceOnlineStatus = useAppStore((s) => s.refreshDeviceOnlineStatus)
  const dataSource = useAppStore((s) => s.dataSource)
  const showToast = useAppStore((s) => s.showToast)
  const [refreshing, setRefreshing] = useState(false)
  const [pluginRefreshToken, setPluginRefreshToken] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  const { plugin, loaded: pluginsLoaded } = useMatchedPlugin(device?.model)

  useEffect(() => {
    if (!id) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Nested sheets (e.g. PC boot timer) keep the detail dialog open
      if (dialogRef.current?.querySelector('.pcboot-overlay')) return
      closeDeviceDetail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, closeDeviceDetail])

  useEffect(() => {
    if (!id) return
    dialogRef.current?.focus()
  }, [id])

  // Persist may still say offline; always re-check presence when opening detail
  useEffect(() => {
    if (dataSource !== 'live' || !id) return
    void refreshDeviceOnlineStatus(id)
  }, [dataSource, id, refreshDeviceOnlineStatus])

  if (!id) return null

  const title = device?.name || device?.nameKey || '设备详情'
  const pcBoot = device ? isPcBootDevice(device) : false
  const waitingPlugins = Boolean(device) && !pcBoot && !pluginsLoaded && Boolean(window.miHome?.plugins)
  const useReactPlugin = Boolean(device) && !pcBoot && pluginsLoaded && Boolean(plugin)

  const handleRefresh = async () => {
    if (!device || refreshing || waitingPlugins) return
    setRefreshing(true)
    try {
      if (useReactPlugin) {
        if (dataSource === 'live') {
          await Promise.all([
            refreshDeviceSnapshot(device.id),
            refreshDeviceOnlineStatus(device.id),
          ])
        }
        setPluginRefreshToken((n) => n + 1)
        showToast('已刷新')
        return
      }
      await refreshDeviceDetail(device.id, device.type)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div
      className="device-detail-overlay"
      role="presentation"
      onClick={closeDeviceDetail}
    >
      <div
        ref={dialogRef}
        className="device-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-detail-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="detail-toolbar">
          <div className="detail-toolbar-title">
            <div className="detail-toolbar-heading">
              <h1 id="device-detail-title">{title}</h1>
              {device?.model ? (
                <code className="detail-model">model:{device.model}</code>
              ) : null}
            </div>
            {device ? (
              <span className={`status-dot${device.status === 'offline' ? ' offline' : ''}`}>
                {device.status === 'online' ? '在线' : '离线'}
              </span>
            ) : null}
          </div>
          <div className="detail-toolbar-actions">
            {device ? (
              <button
                type="button"
                className={`btn btn-ghost refresh-btn${refreshing ? ' spinning' : ''}`}
                disabled={refreshing || waitingPlugins}
                onClick={() => void handleRefresh()}
                title={refreshing ? '正在同步…' : '刷新'}
                aria-label={refreshing ? '正在同步…' : '刷新'}
              >
                <IconRefresh />
              </button>
            ) : null}
            <button
              type="button"
              className="filter-dialog-close"
              onClick={closeDeviceDetail}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
        </div>

        <div className="device-detail-page">
          {!device ? (
            <p>暂无设备</p>
          ) : pcBoot ? (
            <PcBootDetail device={device} />
          ) : waitingPlugins ? (
            <p className="meta soft">正在安装…</p>
          ) : useReactPlugin && plugin ? (
            <PluginDetail
              device={device}
              plugin={plugin}
              refreshToken={pluginRefreshToken}
            />
          ) : (
            <>
              {device.type === 'light' && <LightDetail device={device} />}
              {device.type === 'plug' && <PlugDetail device={device} />}
              {device.type === 'air-purifier' && <PurifierDetail device={device} />}
              {device.type === 'camera' && <CameraDetail device={device} />}
              {device.type === 'lock' && <LockDetail device={device} />}
              {device.type === 'speaker' && <SpeakerDetail device={device} />}
              {device.type === 'scale' && <ScaleDetail device={device} />}
              {device.type === 'ab-wheel' && <AbWheelDetail device={device} />}
              {device.type === 'ac' && <AcDetail device={device} />}
              {device.type === 'massager' && <MassagerDetail device={device} />}
              {device.type === 'dehumidifier' && <DehumidifierDetail device={device} />}
              {!['light', 'plug', 'air-purifier', 'camera', 'lock', 'speaker', 'scale', 'ab-wheel', 'ac', 'massager', 'dehumidifier'].includes(
                device.type,
              ) && <GenericDetail device={device} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
