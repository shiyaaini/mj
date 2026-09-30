import type { Device } from '@mi-home/shared'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import '@/devices/shared/detail.css'

interface Props {
  device: Device
}

export function CameraDetail({ device }: Props) {
  return (
    <div className="detail-layout">
      <div className="camera-layout">
        <section className="panel camera-stage">
          <div className="camera-top">
            <span>实时预览</span>
            <span>1080P</span>
          </div>
          <div className="camera-feed">
            <p>实时画面</p>
            <small>摄像头直播将在后续版本接入</small>
          </div>
          <div className="camera-actions">
            {['截图', '录像', '对讲', '回看', '更多'].map((label) => (
              <button key={label} type="button" className="btn btn-ghost">
                {label}
              </button>
            ))}
          </div>
        </section>

        <aside className="panel camera-side">
          <h2>设置</h2>
          <p className="cloud">云存储 · 7 天循环</p>
          <ul className="settings-list">
            {['视频设置', '图像设置', '移动侦测', '通知设置'].map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </aside>
      </div>

      <DeviceCapabilityPanel device={device} asSupplement />
    </div>
  )
}
