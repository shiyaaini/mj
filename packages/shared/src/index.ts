export type DeviceType =
  | 'air-purifier'
  | 'camera'
  | 'light'
  | 'vacuum'
  | 'plug'
  | 'pc-boot'
  | 'sensor'
  | 'lock'
  | 'speaker'
  | 'scale'
  | 'ab-wheel'
  | 'ac'
  | 'massager'
  | 'dehumidifier'
  | 'generic'

export type DeviceStatus = 'online' | 'offline'

export type DataSource = 'mock' | 'live'

export interface Room {
  id: string
  nameKey: string
  /** Live room display name when not using i18n key */
  name?: string
}

export interface Device {
  id: string
  nameKey: string
  /** Live device name from cloud */
  name?: string
  model?: string
  roomId: string
  roomName?: string
  type: DeviceType
  status: DeviceStatus
  /** Bridge-hosted product icon URL (absolute or /models/.../icon) */
  iconUrl?: string
  /** Quick preview fields for cards */
  preview?: Record<string, string | number | boolean>
}

export interface Scene {
  id: string
  nameKey: string
  descKey: string
  icon: string
  /** Live scene display name */
  name?: string
  homeId?: string
}

export interface AutomationRule {
  id: string
  nameKey: string
  enabled: boolean
}

export interface UnlockRecord {
  id: string
  methodKey: string
  time: string
}
