import type { BridgeDevice, BridgeHome, BridgeScene } from '@/api/bridge'
import { resolveBridgeAssetUrl } from '@/api/bridge'
import type { Device, DeviceType, Room, Scene } from '@mi-home/shared'

/** Built-in UI filter category inferred from model keywords */
export type DeviceCategory =
  | 'speaker'
  | 'light'
  | 'plug'
  | 'sensor'
  | 'scale'
  | 'ab-wheel'
  | 'fridge'
  | 'air-purifier'
  | 'camera'
  | 'vacuum'
  | 'lock'
  | 'ac'
  | 'massager'
  | 'dehumidifier'
  | 'other'

export interface CustomCategoryRule {
  id: string
  /** Substring matched against device model (and name) */
  keyword: string
  /** Display label */
  label: string
}

/** Categories always shown in the filter grid */
export const BUILTIN_FILTER_CATEGORIES: DeviceCategory[] = [
  'speaker',
  'light',
  'plug',
  'sensor',
  'scale',
  'ab-wheel',
  'fridge',
  'ac',
  'massager',
  'dehumidifier',
  'air-purifier',
  'camera',
  'vacuum',
  'lock',
  'other',
]

export function inferDeviceCategory(model: string, name = ''): DeviceCategory {
  const m = `${model} ${name}`.toLowerCase()
  if (/speaker|wifispeaker|音箱|小爱/.test(m)) return 'speaker'
  if (/light|lamp|bulb|yeelight|灯|mbulb/.test(m)) return 'light'
  if (/plug|outlet|socket|插座|排气|cuco\.plug/.test(m)) return 'plug'
  if (/fridge|refrigerator|冰柜|冰箱/.test(m)) return 'fridge'
  if (/scale|scales|体重|体脂|yunmai\.scales/.test(m)) return 'scale'
  if (/abwheel|ab-wheel|ab_wheel|健腹轮/.test(m)) return 'ab-wheel'
  if (/sensor|温湿|温度|湿度/.test(m)) return 'sensor'
  if (/aircondition|air.?cond|空调/.test(m)) return 'ac'
  if (/magic_touch|massager|massage|按摩/.test(m)) return 'massager'
  if (/derh|dehumid|除湿/.test(m)) return 'dehumidifier'
  if (/airp|airpurifier|air-purifier|净化/.test(m)) return 'air-purifier'
  if (/camera|摄像头|摄像机/.test(m)) return 'camera'
  if (/vacuum|sweeper|robot|扫地/.test(m)) return 'vacuum'
  if (/lock|门锁/.test(m)) return 'lock'
  return 'other'
}

export function resolveDeviceCategoryId(
  device: Pick<Device, 'model' | 'name' | 'nameKey' | 'type'>,
  custom: CustomCategoryRule[] = [],
): string {
  const text = `${device.model || ''} ${device.name || device.nameKey || ''}`.toLowerCase()
  for (const rule of custom) {
    const kw = rule.keyword.trim().toLowerCase()
    if (kw && text.includes(kw)) return rule.id
  }
  if (device.model) return inferDeviceCategory(device.model, device.name || device.nameKey || '')
  if (
    device.type === 'speaker' ||
    device.type === 'light' ||
    device.type === 'plug' ||
    device.type === 'sensor' ||
    device.type === 'scale' ||
    device.type === 'ab-wheel' ||
    device.type === 'air-purifier' ||
    device.type === 'camera' ||
    device.type === 'vacuum' ||
    device.type === 'lock' ||
    device.type === 'ac' ||
    device.type === 'massager' ||
    device.type === 'dehumidifier'
  ) {
    return device.type
  }
  return 'other'
}

export function countDevicesByCategory(
  devices: Device[],
  custom: CustomCategoryRule[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const d of devices) {
    const id = resolveDeviceCategoryId(d, custom)
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  return counts
}

export function makeCustomCategory(keyword: string, label?: string): CustomCategoryRule | null {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return null
  return {
    id: `custom:${kw}`,
    keyword: kw,
    label: (label || keyword).trim() || kw,
  }
}

export function inferDeviceType(model: string, name: string): DeviceType {
  const m = `${model} ${name}`.toLowerCase()
  // HiPC PC startup card — dedicated detail UI (still filterable as plug)
  if (/hipc\.plug/.test(m)) return 'pc-boot'
  const cat = inferDeviceCategory(model, name)
  if (cat === 'fridge' || cat === 'other') {
    return 'generic'
  }
  return cat
}

/** True for HiPC 电脑开机卡 (even if persisted type is still plug) */
export function isPcBootDevice(device: Pick<Device, 'model' | 'type'>) {
  return device.type === 'pc-boot' || /hipc\.plug/i.test(device.model || '')
}

/** @deprecated use resolveDeviceCategoryId */
export function getDeviceCategory(
  device: Pick<Device, 'model' | 'name' | 'nameKey' | 'type'>,
): DeviceCategory {
  return resolveDeviceCategoryId(device) as DeviceCategory
}

export function mapBridgeDevice(device: BridgeDevice, prev?: Device): Device {
  const type = inferDeviceType(device.model, device.name)
  const roomName = device.raw?._room_name || undefined
  const nextIcon = resolveBridgeAssetUrl(device.icon_url)
  return {
    id: device.id,
    nameKey: device.name,
    name: device.name,
    model: device.model,
    roomId: device.room_id || 'unassigned',
    roomName: roomName || undefined,
    type,
    status: device.online ? 'online' : 'offline',
    // Keep previous icon if this sync didn't include one yet
    iconUrl: nextIcon || prev?.iconUrl,
    preview: {},
  }
}

const sceneIcons = ['home', 'leave', 'sleep', 'movie', 'read'] as const

export function mapBridgeScene(scene: BridgeScene, index: number): Scene {
  return {
    id: scene.id,
    nameKey: scene.name,
    descKey: '',
    icon: sceneIcons[index % sceneIcons.length],
    name: scene.name,
    homeId: scene.home_id ?? undefined,
  }
}

/** Sort by model A–Z (case-insensitive); tie-break by display name */
export function compareDevicesByModel(a: Device, b: Device) {
  const ma = (a.model || '').trim().toLowerCase()
  const mb = (b.model || '').trim().toLowerCase()
  const byModel = ma.localeCompare(mb, undefined, { sensitivity: 'base' })
  if (byModel !== 0) return byModel
  return (a.name || a.nameKey || a.id).localeCompare(
    b.name || b.nameKey || b.id,
    undefined,
    { sensitivity: 'base' },
  )
}

export const ALL_ROOM: Room = { id: 'all', nameKey: '全部', name: '全部' }

/** Flatten Xiaomi homes → room tabs (全部 + unique rooms by cloud id). */
export function mapHomesToRooms(homes: BridgeHome[]): Room[] {
  const byId = new Map<string, Room>()
  for (const home of homes) {
    for (const room of home.rooms || []) {
      const id = String(room.id ?? room.roomId ?? '').trim()
      const name = String(room.name ?? '').trim()
      if (!id || !name || byId.has(id)) continue
      byId.set(id, { id, nameKey: name, name })
    }
  }
  const list = [...byId.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'zh', { sensitivity: 'base' }),
  )
  return [ALL_ROOM, ...list]
}

/**
 * Xiaomi device list often has no room_id; assign from home room.dids.
 */
export function applyRoomMembershipFromHomes(
  devices: Device[],
  homes: BridgeHome[],
): Device[] {
  const didToRoom = new Map<string, { id: string; name: string }>()
  for (const home of homes) {
    for (const room of home.rooms || []) {
      const id = String(room.id ?? room.roomId ?? '').trim()
      const name = String(room.name ?? '').trim()
      if (!id) continue
      for (const did of room.dids || []) {
        const key = String(did).trim()
        if (key && !didToRoom.has(key)) {
          didToRoom.set(key, { id, name })
        }
      }
    }
  }
  if (!didToRoom.size) return devices

  return devices.map((d) => {
    const hit = didToRoom.get(d.id)
    if (!hit) return d
    if (d.roomId === hit.id && (d.roomName || '') === (hit.name || d.roomName || '')) {
      return d
    }
    return {
      ...d,
      roomId: hit.id,
      roomName: hit.name || d.roomName,
    }
  })
}

/** Fallback when /homes fails: derive tabs from device roomId / roomName. */
export function roomsFromDevices(devices: Device[]): Room[] {
  const byId = new Map<string, Room>()
  for (const d of devices) {
    const id = (d.roomId || '').trim()
    if (!id || id === 'all' || id === 'unassigned' || byId.has(id)) continue
    const name = (d.roomName || id).trim()
    byId.set(id, { id, nameKey: name, name })
  }
  const list = [...byId.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'zh', { sensitivity: 'base' }),
  )
  return [ALL_ROOM, ...list]
}
