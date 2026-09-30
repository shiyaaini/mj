import type { Device } from '@mi-home/shared'
import { useAppStore } from '@/stores/appStore'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import { DetailPowerButton } from '@/devices/shared/DetailPowerButton'
import '@/devices/shared/detail.css'

interface Props {
  device: Device
}

export function GenericDetail({ device }: Props) {
  const dataSource = useAppStore((s) => s.dataSource)
  const toggleDevicePower = useAppStore((s) => s.toggleDevicePower)

  if (dataSource === 'mock') {
    const power = Boolean(device.preview?.power)
    return (
      <div className="detail-layout">
        <section className="panel hero-panel">
          <div className="detail-power-wrap">
            <DetailPowerButton
              on={power}
              label={power ? "已开启" : "已关闭"}
              onClick={() => void toggleDevicePower(device.id)}
            />
          </div>
        </section>
      </div>
    )
  }

  return <DeviceCapabilityPanel device={device} />
}
