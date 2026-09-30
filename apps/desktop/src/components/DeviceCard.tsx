import { useEffect, useRef, useState } from 'react'
import type { Device } from '@mi-home/shared'
import {
  getCachedIconStatus,
  markIconFailed,
  markIconReady,
  prefetchDeviceIcon,
} from '@/lib/deviceIconCache'
import { ROOM_LABELS } from '@/labels'
import { deviceGlyph } from './Icons'
import { useAppStore } from '@/stores/appStore'

interface Props {
  device: Device
}

function isSwitchable(device: Device) {
  return ['plug', 'light', 'air-purifier'].includes(device.type) || 'power' in (device.preview ?? {})
}

function initialIconState(iconUrl: string | undefined) {
  const cached = getCachedIconStatus(iconUrl)
  return {
    ready: cached === 'ready',
    failed: cached === 'failed',
  }
}

export function DeviceCard({ device }: Props) {
  const toggleDevicePower = useAppStore((s) => s.toggleDevicePower)
  const openDeviceDetail = useAppStore((s) => s.openDeviceDetail)
  const dataSource = useAppStore((s) => s.dataSource)
  const cachedPower = useAppStore((s) => s.deviceCache[device.id]?.power)
  const imgRef = useRef<HTMLImageElement>(null)
  const initial = initialIconState(device.iconUrl)
  const [iconFailed, setIconFailed] = useState(initial.failed)
  const [iconReady, setIconReady] = useState(initial.ready)

  useEffect(() => {
    const url = device.iconUrl
    if (!url) {
      setIconFailed(false)
      setIconReady(false)
      return
    }

    const cached = getCachedIconStatus(url)
    if (cached === 'ready') {
      setIconFailed(false)
      setIconReady(true)
      return
    }
    if (cached === 'failed') {
      setIconFailed(true)
      setIconReady(false)
      return
    }

    const img = imgRef.current
    if (img?.complete && img.naturalWidth > 0) {
      markIconReady(url)
      setIconFailed(false)
      setIconReady(true)
      return
    }

    setIconFailed(false)
    setIconReady(false)
    // Warm decode even if <img> is slow to attach / remount mid-load
    void prefetchDeviceIcon(url).then((ok) => {
      if (device.iconUrl !== url) return
      setIconFailed(!ok)
      setIconReady(ok)
    })
  }, [device.iconUrl, device.id])

  const title = device.name || device.nameKey
  const roomLabel = device.roomName
    ? device.roomName
    : device.roomId && device.roomId !== 'all' && device.roomId !== 'unassigned'
      ? ROOM_LABELS[device.roomId] || device.roomId
      : '未分配房间'
  const switchable = isSwitchable(device)
  const power =
    cachedPower !== undefined
      ? Boolean(cachedPower)
      : typeof device.preview?.power === 'boolean'
        ? Boolean(device.preview.power)
        : undefined
  const powerKnown = power !== undefined
  const powerOn = Boolean(power)
  const hasIconUrl = Boolean(device.iconUrl)
  const showProductIcon = hasIconUrl && !iconFailed && iconReady
  // Only show glyph when there is no product icon (or it failed) — avoids ◆ flash while img loads
  const showGlyphFallback = !hasIconUrl || iconFailed

  return (
    <div className={`device-card-wrap${switchable ? ' has-switch' : ''}`}>
      <button
        type="button"
        className="device-card"
        onClick={() => openDeviceDetail(device.id)}
      >
        <div className="device-card-top">
          <div
            className={`device-icon type-${device.type}${
              hasIconUrl && !iconFailed ? ' has-img' : ''
            }${hasIconUrl && !iconFailed && !iconReady ? ' is-icon-loading' : ''}`}
          >
            {showGlyphFallback ? (
              <span className="device-icon-fallback" aria-hidden>
                {deviceGlyph(device.type)}
              </span>
            ) : null}
            {hasIconUrl && !iconFailed ? (
              <img
                ref={imgRef}
                className={showProductIcon ? 'device-icon-img' : 'device-icon-img is-loading'}
                src={device.iconUrl}
                alt=""
                loading="eager"
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={() => {
                  if (device.iconUrl) markIconReady(device.iconUrl)
                  setIconReady(true)
                }}
                onError={() => {
                  if (device.iconUrl) markIconFailed(device.iconUrl)
                  setIconFailed(true)
                  setIconReady(false)
                }}
              />
            ) : null}
          </div>
          <span className={`status-dot${device.status === 'offline' ? ' offline' : ''}`}>
            {device.status === 'online' ? '在线' : '离线'}
          </span>
        </div>
        <h3 className="device-card-title">{title}</h3>
        <div className="device-card-meta">{roomLabel}</div>
        {dataSource === 'live' && device.model ? (
          <div className="device-card-model">{device.model}</div>
        ) : (
          <div className="device-card-model spacer" />
        )}
      </button>
      {switchable ? (
        <button
          type="button"
          className={`card-switch${powerOn ? ' on' : ''}${powerKnown ? '' : ' unknown'}`}
          title={
            powerKnown
              ? powerOn
                ? "已开启"
                : "已关闭"
              : "正在同步…"
          }
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void toggleDevicePower(device.id)
          }}
        >
          <i />
        </button>
      ) : null}
    </div>
  )
}
