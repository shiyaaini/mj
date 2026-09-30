import { useMemo } from 'react'
import { DeviceCard } from '@/components/DeviceCard'
import { compareDevicesByModel } from '@/lib/deviceMap'
import { ROOM_LABELS } from '@/labels'
import { useAppStore } from '@/stores/appStore'

export function HomePage() {
  const devices = useAppStore((s) => s.devices)
  const rooms = useAppStore((s) => s.rooms)
  const roomFilter = useAppStore((s) => s.roomFilter)
  const setRoomFilter = useAppStore((s) => s.setRoomFilter)

  // Keep all cards mounted so icons stay warm when switching rooms
  const sorted = useMemo(
    () => [...devices].sort(compareDevicesByModel),
    [devices],
  )
  const visibleCount = useMemo(
    () =>
      roomFilter === 'all'
        ? sorted.length
        : sorted.filter((d) => d.roomId === roomFilter).length,
    [sorted, roomFilter],
  )

  const recent = devices.slice(0, 3)

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>你好，欢迎使用米家</h1>
          <p>一屏掌控全屋智能设备</p>
        </div>
      </header>

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

      <section>
        <h2 className="section-title">我的设备</h2>
        {sorted.length === 0 || visibleCount === 0 ? (
          <p className="empty">暂无设备</p>
        ) : null}
        {sorted.length > 0 ? (
          <div className={`card-grid${visibleCount === 0 ? ' is-empty-filter' : ''}`}>
            {sorted.map((device) => {
              const hidden = roomFilter !== 'all' && device.roomId !== roomFilter
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
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 className="section-title">最近使用</h2>
        <div className="card-grid">
          {recent.map((device) => (
            <DeviceCard key={`recent-${device.id}`} device={device} />
          ))}
        </div>
      </section>
    </div>
  )
}
