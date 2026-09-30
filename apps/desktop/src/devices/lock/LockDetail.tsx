import type { Device } from '@mi-home/shared'
import { unlockRecords } from '@/mock/data'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import '@/devices/shared/detail.css'

interface Props {
  device: Device
}

export function LockDetail({ device }: Props) {
  const battery = Number(device.preview?.battery ?? 85)

  return (
    <div className="detail-layout">
      <section className="panel hero-panel">
        <div className="battery-hero">
          <strong>{battery}%</strong>
          <span>电量</span>
          <div className="battery-bar">
            <i style={{ width: `${battery}%` }} />
          </div>
        </div>
        <div className="control-row">
          {['密码', '指纹', 'NFC', '远程开锁'].map((label) => (
            <button key={label} type="button" className="mode-btn">
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>开锁记录</h2>
        <ul className="record-list">
          {unlockRecords.map((r) => (
            <li key={r.id}>
              <span>{r.methodKey}</span>
              <time>{r.time}</time>
            </li>
          ))}
        </ul>
      </section>

      <DeviceCapabilityPanel device={device} asSupplement />
    </div>
  )
}
