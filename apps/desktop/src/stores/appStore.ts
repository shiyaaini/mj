import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  automations as seedAutomations,
  devices as seedDevices,
  rooms as seedRooms,
  scenes as seedScenes,
} from '@/mock/data'
import { bridgeApi, resolveBridgeAssetUrl, type DeviceCapabilities, type UserProfile } from '@/api/bridge'
import { prefetchDeviceIcons } from '@/lib/deviceIconCache'
import {
  mergeCapabilityValues,
  readablePropNames,
  valuesEqual,
  type CachedCapabilities,
} from '@/lib/capabilityCache'
import {
  cacheEquals,
  mergeCache,
  snapshotToCache,
  type CachedDeviceState,
} from '@/lib/deviceCache'
import { inferDeviceType, mapBridgeDevice, mapBridgeScene, mapHomesToRooms, makeCustomCategory, roomsFromDevices, applyRoomMembershipFromHomes, type CustomCategoryRule } from '@/lib/deviceMap'
import { schemaMissingAccess } from '@/lib/propFormat'
import { AUTOMATION_LABELS } from '@/labels'
import type { AutomationRule, DataSource, Device, Room, Scene } from '@mi-home/shared'

interface AppState {
  authenticated: boolean
  dataSource: DataSource
  roomFilter: string
  rooms: Room[]
  devices: Device[]
  scenes: Scene[]
  automations: AutomationRule[]
  /** User-defined filter types matched by model keyword */
  customCategories: CustomCategoryRule[]
  /** Last known device UI state, persisted across restarts */
  deviceCache: Record<string, CachedDeviceState>
  /** Last known Spec UI (generic devices), persisted for instant reopen */
  capabilityCache: Record<string, CachedCapabilities>
  /** Cached Mi account profile (nickname / avatar), persisted */
  userProfile: UserProfile | null
  userProfileFetchedAt: number | null
  syncing: boolean
  toast: string | null
  /** Open device detail dialog (null = closed) */
  detailDeviceId: string | null
  login: (source?: DataSource) => void
  logout: () => void
  openDeviceDetail: (id: string) => void
  closeDeviceDetail: () => void
  setRoomFilter: (roomId: string) => void
  setDevices: (devices: Device[]) => void
  setScenes: (scenes: Scene[]) => void
  addCustomCategory: (keyword: string, label?: string) => boolean
  removeCustomCategory: (id: string) => void
  getDeviceCache: (id: string) => CachedDeviceState | undefined
  getCapabilityCache: (id: string) => CachedCapabilities | undefined
  rememberDeviceState: (id: string, patch: Partial<CachedDeviceState>) => void
  rememberCapabilities: (id: string, caps: DeviceCapabilities) => void
  patchDevicePreview: (id: string, preview: Record<string, string | number | boolean>) => void
  toggleDevicePower: (id: string) => Promise<void>
  setPurifierMode: (id: string, mode: string) => Promise<void>
  toggleAutomation: (id: string) => void
  syncFromBridge: () => Promise<boolean>
  /** Download product icons from miot-spec; merge iconUrl onto devices */
  refreshDeviceIcons: () => Promise<void>
  /** Cache-first account profile; skips network when cache is fresh unless force */
  refreshUserProfile: (force?: boolean) => Promise<UserProfile | null>
  /** Hydrate from cache immediately; refresh cloud in background; update only on diff */
  refreshDeviceSnapshot: (id: string) => Promise<CachedDeviceState | undefined>
  /** Cache-first Spec UI; with cache, only refresh property values. force=true refetches full Spec. */
  refreshDeviceCapabilities: (
    id: string,
    force?: boolean,
  ) => Promise<DeviceCapabilities | undefined>
  /** Manual refresh for a device detail page */
  refreshDeviceDetail: (id: string, type: Device['type']) => Promise<boolean>
  /** Refresh online/offline (and name) from bridge device list */
  refreshDeviceOnlineStatus: (id?: string) => Promise<void>
  /** Background: refresh power for list cards (plug / light / purifier) */
  refreshListPreviews: () => Promise<void>
  runScene: (scene: Scene) => Promise<void>
  showToast: (message: string) => void
  clearToast: () => void
}

function applyCacheToDevices(
  devices: Device[],
  cache: Record<string, CachedDeviceState>,
): Device[] {
  return devices.map((d) => {
    const c = cache[d.id]
    if (!c) return d
    return {
      ...d,
      preview: {
        ...d.preview,
        ...(c.power !== undefined ? { power: c.power } : {}),
        ...(c.brightness !== undefined ? { brightness: c.brightness } : {}),
        ...(c.colorTemp !== undefined ? { colorTemp: c.colorTemp } : {}),
        ...(c.mode !== undefined ? { mode: c.mode } : {}),
        ...(c.pm25 !== undefined ? { pm25: c.pm25 } : {}),
        ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
        ...(c.humidity !== undefined ? { humidity: c.humidity } : {}),
        ...(c.filter !== undefined ? { filter_life_level: c.filter } : {}),
      },
    }
  })
}

function isListSwitchable(device: Device) {
  return (
    ['plug', 'pc-boot', 'light', 'air-purifier'].includes(device.type) ||
    /hipc\.plug/i.test(device.model || '')
  )
}

/** Nickname/avatar rarely change — reuse cache within this window */
const USER_PROFILE_TTL_MS = 24 * 60 * 60 * 1000

async function mapPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const queue = [...items]
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      if (item === undefined) break
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      authenticated: false,
      dataSource: 'mock',
      roomFilter: 'all',
      rooms: seedRooms,
      devices: seedDevices,
      scenes: seedScenes,
      automations: seedAutomations,
      customCategories: [],
      deviceCache: {},
      capabilityCache: {},
      userProfile: null,
      userProfileFetchedAt: null,
      syncing: false,
      toast: null,
      detailDeviceId: null,

      login: (source = 'mock') =>
        set({
          authenticated: true,
          dataSource: source,
          devices: source === 'mock' ? seedDevices : get().devices,
          scenes: source === 'mock' ? seedScenes : get().scenes,
          rooms: source === 'mock' ? seedRooms : get().rooms,
          roomFilter: source === 'mock' ? 'all' : get().roomFilter,
          detailDeviceId: null,
          ...(source === 'mock'
            ? {
                userProfile: null,
                userProfileFetchedAt: null,
              }
            : {}),
        }),

      logout: () =>
        set({
          authenticated: false,
          dataSource: 'mock',
          devices: seedDevices,
          scenes: seedScenes,
          rooms: seedRooms,
          roomFilter: 'all',
          detailDeviceId: null,
          userProfile: null,
          userProfileFetchedAt: null,
          // keep deviceCache so next live login still has last UI
        }),

      openDeviceDetail: (id) => set({ detailDeviceId: id }),
      closeDeviceDetail: () => set({ detailDeviceId: null }),

      setRoomFilter: (roomId) => set({ roomFilter: roomId }),
      setDevices: (devices) => set({ devices }),
      setScenes: (scenes) => set({ scenes }),

      addCustomCategory: (keyword, label) => {
        const rule = makeCustomCategory(keyword, label)
        if (!rule) return false
        const exists = get().customCategories.some(
          (c) => c.id === rule.id || c.keyword === rule.keyword,
        )
        if (exists) return false
        set({ customCategories: [...get().customCategories, rule] })
        return true
      },

      removeCustomCategory: (id) =>
        set({
          customCategories: get().customCategories.filter((c) => c.id !== id),
        }),

      getDeviceCache: (id) => get().deviceCache[id],
      getCapabilityCache: (id) => get().capabilityCache[id],

      rememberCapabilities: (id, caps) => {
        set({
          capabilityCache: {
            ...get().capabilityCache,
            [id]: { caps, updatedAt: Date.now() },
          },
        })
        const switchProp = caps.properties.find(
          (p) =>
            String(p.rw || '').includes('w') &&
            p.type === 'bool' &&
            (p.name === 'on' || p.name.startsWith('on-') || p.name.startsWith('on_')),
        )
        if (switchProp && caps.values[switchProp.name] !== undefined) {
          get().rememberDeviceState(id, { power: Boolean(caps.values[switchProp.name]) })
        }
      },

      rememberDeviceState: (id, patch) => {
        const prev = get().deviceCache[id]
        const next = mergeCache(prev, { ...patch, updatedAt: Date.now() })
        set({
          deviceCache: { ...get().deviceCache, [id]: next },
        })
        const preview: Record<string, string | number | boolean> = {}
        if (patch.power !== undefined) preview.power = patch.power
        if (patch.brightness !== undefined) preview.brightness = patch.brightness
        if (patch.colorTemp !== undefined) preview.colorTemp = patch.colorTemp
        if (patch.mode !== undefined) preview.mode = patch.mode
        if (patch.pm25 !== undefined) preview.pm25 = patch.pm25
        if (patch.temperature !== undefined) preview.temperature = patch.temperature
        if (patch.humidity !== undefined) preview.humidity = patch.humidity
        if (patch.filter !== undefined) preview.filter_life_level = patch.filter
        if (Object.keys(preview).length) get().patchDevicePreview(id, preview)
      },

      patchDevicePreview: (id, preview) =>
        set({
          devices: get().devices.map((d) =>
            d.id === id ? { ...d, preview: { ...d.preview, ...preview } } : d,
          ),
        }),

      toggleDevicePower: async (id) => {
        const device = get().devices.find((d) => d.id === id)
        if (!device) return
        const current =
          get().deviceCache[id]?.power ??
          (typeof device.preview?.power === 'boolean' ? Boolean(device.preview.power) : false)
        const next = !current
        get().rememberDeviceState(id, { power: next })
        if (get().dataSource === 'live') {
          try {
            await bridgeApi.setSwitch(id, next)
          } catch (err) {
            get().rememberDeviceState(id, { power: !next })
            get().showToast(err instanceof Error ? err.message : 'Set property failed')
          }
        }
      },

      setPurifierMode: async (id, mode) => {
        const prev = get().deviceCache[id]?.mode
        get().rememberDeviceState(id, { mode, power: true })
        if (get().dataSource === 'live') {
          try {
            await bridgeApi.setProp(id, 'mode', mode)
          } catch (err) {
            if (prev !== undefined) get().rememberDeviceState(id, { mode: prev })
            get().showToast(err instanceof Error ? err.message : 'Set mode failed')
          }
        }
      },

      toggleAutomation: (id) =>
        set({
          automations: get().automations.map((a) =>
            a.id === id ? { ...a, enabled: !a.enabled } : a,
          ),
        }),

      syncFromBridge: async () => {
        set({ syncing: true })
        try {
          const [devicesRes, scenesRes, homesRes] = await Promise.all([
            bridgeApi.listDevices(),
            bridgeApi.listScenes(),
            bridgeApi.listHomes().catch(() => ({ homes: [] })),
          ])
          const prevById = new Map(get().devices.map((d) => [d.id, d]))
          const mapped = devicesRes.devices.map((d) => mapBridgeDevice(d, prevById.get(d.id)))
          const withRooms = applyRoomMembershipFromHomes(mapped, homesRes.homes)
          const withCache = applyCacheToDevices(withRooms, get().deviceCache)
          const fromHomes = mapHomesToRooms(homesRes.homes)
          const nextRooms =
            fromHomes.length > 1 ? fromHomes : roomsFromDevices(withCache)
          const prevFilter = get().roomFilter
          const roomFilter = nextRooms.some((r) => r.id === prevFilter)
            ? prevFilter
            : 'all'
          set({
            dataSource: 'live',
            devices: withCache,
            scenes: scenesRes.scenes.map(mapBridgeScene),
            rooms: nextRooms,
            roomFilter,
            syncing: false,
          })
          // Warm icons early for devices that already have iconUrl from list/persist
          void prefetchDeviceIcons(withCache.map((d) => d.iconUrl))
          // Don't block list UI — fill switch states / profile / icons in background
          void get().refreshListPreviews()
          void get().refreshUserProfile(false)
          void get().refreshDeviceIcons()
          return true
        } catch (err) {
          set({ syncing: false })
          get().showToast(err instanceof Error ? err.message : 'Sync failed')
          return false
        }
      },

      refreshDeviceIcons: async () => {
        if (get().dataSource !== 'live') return
        const devices = get().devices
        const models = [
          ...new Set(devices.map((d) => d.model).filter((m): m is string => Boolean(m))),
        ]
        if (!models.length) return

        // Only download models that still lack a usable iconUrl (avoid slow re-sync wiping UI)
        const missing = [
          ...new Set(
            devices
              .filter((d) => d.model && !d.iconUrl)
              .map((d) => d.model as string),
          ),
        ]

        try {
          if (missing.length) {
            await bridgeApi.syncModelIcons({ models: missing, force: false })
          }
          const devicesRes = await bridgeApi.listDevices()
          const iconById = new Map(
            devicesRes.devices.map((d) => [d.id, resolveBridgeAssetUrl(d.icon_url)]),
          )
          const nextDevices = get().devices.map((d) => {
            const iconUrl = iconById.get(d.id) || d.iconUrl
            return iconUrl && iconUrl !== d.iconUrl ? { ...d, iconUrl } : d
          })
          set({ devices: nextDevices })
          // Warm browser/session icon cache so room-filter remounts paint instantly
          void prefetchDeviceIcons(nextDevices.map((d) => d.iconUrl))
        } catch {
          /* icon sync is best-effort */
        }
      },

      refreshUserProfile: async (force = false) => {
        if (get().dataSource !== 'live') {
          return get().userProfile
        }
        const cached = get().userProfile
        const fetchedAt = get().userProfileFetchedAt
        const fresh =
          Boolean(cached?.nickname || cached?.avatar_url || cached?.user_id) &&
          typeof fetchedAt === 'number' &&
          Date.now() - fetchedAt < USER_PROFILE_TTL_MS
        if (!force && fresh) {
          return cached
        }
        try {
          const data = await bridgeApi.getProfile()
          set({
            userProfile: data,
            userProfileFetchedAt: Date.now(),
          })
          return data
        } catch (err) {
          if (!cached) {
            get().showToast(err instanceof Error ? err.message : 'Sync failed')
          }
          return cached
        }
      },

      refreshListPreviews: async () => {
        if (get().dataSource !== 'live') return
        const targets = get().devices.filter(
          (d) => isListSwitchable(d) && d.status === 'online',
        )
        if (!targets.length) return

        await mapPool(targets, 3, async (device) => {
          try {
            const sw = await bridgeApi.getSwitch(device.id)
            if (sw.value != null) {
              get().rememberDeviceState(device.id, {
                power: Boolean(sw.value),
                ...(sw.name ? { switchName: sw.name } : {}),
              })
              return
            }
            // Fallback for devices whose switch prop name is non-standard
            const snap = await bridgeApi.getSnapshot(device.id)
            if (snap.switch?.value != null) {
              get().rememberDeviceState(device.id, {
                power: Boolean(snap.switch.value),
                ...(snap.switch.name ? { switchName: snap.switch.name } : {}),
              })
            }
          } catch {
            // Keep last cached preview; ignore per-device failures
          }
        })
      },

      refreshDeviceSnapshot: async (id) => {
        if (get().dataSource !== 'live') return get().deviceCache[id]
        try {
          const snap = await bridgeApi.getSnapshot(id)
          const next = snapshotToCache(snap)
          const prev = get().deviceCache[id]
          if (!cacheEquals(prev, next)) {
            get().rememberDeviceState(id, next)
          } else if (prev) {
            // bump timestamp only
            set({
              deviceCache: {
                ...get().deviceCache,
                [id]: { ...prev, updatedAt: Date.now() },
              },
            })
          } else {
            get().rememberDeviceState(id, next)
          }
          return get().deviceCache[id]
        } catch (err) {
          get().showToast(err instanceof Error ? err.message : 'Sync failed')
          return undefined
        }
      },

      refreshDeviceCapabilities: async (id, force = false) => {
        if (get().dataSource !== 'live') return get().capabilityCache[id]?.caps
        const cached = get().capabilityCache[id]
        try {
          const needSchema =
            force || schemaMissingAccess(cached?.caps)
          // With Spec cache: only re-fetch property values (fast). Skip full Spec unless forced.
          if (!needSchema && cached?.caps?.properties?.length) {
            const names = readablePropNames(cached.caps)
            if (names.length) {
              const { props } = await bridgeApi.getProps(id, names)
              const merged = mergeCapabilityValues(cached.caps, props)
              if (!valuesEqual(cached.caps.values, merged.values)) {
                get().rememberCapabilities(id, merged)
                return merged
              }
            }
            set({
              capabilityCache: {
                ...get().capabilityCache,
                [id]: { ...cached, updatedAt: Date.now() },
              },
            })
            return cached.caps
          }

          const data = await bridgeApi.getCapabilities(id, true)
          get().rememberCapabilities(id, data)
          return get().capabilityCache[id]?.caps
        } catch (err) {
          get().showToast(err instanceof Error ? err.message : 'Sync failed')
          return undefined
        }
      },

      refreshDeviceDetail: async (id, type) => {
        if (get().dataSource !== 'live') {
          get().showToast('已刷新')
          return true
        }
        // Templates need snapshot for polished UI; always refresh full Spec
        // so multi-model devices keep unmapped controls.
        const needsSnapshot =
          type === 'light' || type === 'plug' || type === 'air-purifier'
        const [snapOk, capsOk] = await Promise.all([
          needsSnapshot ? get().refreshDeviceSnapshot(id) : Promise.resolve(true),
          get().refreshDeviceCapabilities(id, true),
          get().refreshDeviceOnlineStatus(id),
        ])
        const ok = Boolean(capsOk) && (needsSnapshot ? Boolean(snapOk) : true)
        if (ok) get().showToast('已刷新')
        return ok
      },

      refreshDeviceOnlineStatus: async (id) => {
        if (get().dataSource !== 'live') return
        try {
          const { devices: remote } = await bridgeApi.listDevices()
          const byId = new Map(remote.map((d) => [d.id, d]))
          const next = get().devices.map((d) => {
            if (id && d.id !== id) return d
            const hit = byId.get(d.id)
            if (!hit) return d
            const status = hit.online ? ('online' as const) : ('offline' as const)
            const name = hit.name || d.name
            if (d.status === status && d.name === name && d.model === hit.model) return d
            return {
              ...d,
              status,
              name,
              nameKey: name || d.nameKey,
              model: hit.model || d.model,
              iconUrl: resolveBridgeAssetUrl(hit.icon_url) || d.iconUrl,
            }
          })
          set({ devices: next })
        } catch {
          /* keep cached presence */
        }
      },

      runScene: async (scene) => {
        if (get().dataSource === 'live') {
          try {
            await bridgeApi.runScene(scene.id, scene.homeId)
            get().showToast('已执行场景')
          } catch (err) {
            get().showToast(err instanceof Error ? err.message : 'Run scene failed')
          }
          return
        }
        get().showToast('已执行场景')
      },

      showToast: (message) => {
        set({ toast: message })
        window.setTimeout(() => {
          if (get().toast === message) set({ toast: null })
        }, 2200)
      },
      clearToast: () => set({ toast: null }),
    }),
    {
      name: 'mi-home-app',
      partialize: (s) => ({
        authenticated: s.authenticated,
        dataSource: s.dataSource,
        automations: s.automations,
        customCategories: s.customCategories,
        deviceCache: s.deviceCache,
        capabilityCache: s.capabilityCache,
        userProfile: s.dataSource === 'live' ? s.userProfile : null,
        userProfileFetchedAt: s.dataSource === 'live' ? s.userProfileFetchedAt : null,
        // Persist last live device list for instant reopen
        devices: s.dataSource === 'live' ? s.devices : undefined,
        scenes: s.dataSource === 'live' ? s.scenes : undefined,
        rooms: s.dataSource === 'live' ? s.rooms : undefined,
      }),
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<AppState>
        const cache = p.deviceCache || {}
        const capabilityCache = p.capabilityCache || {}
        const customCategories = Array.isArray(p.customCategories)
          ? (p.customCategories as CustomCategoryRule[])
          : []
        const devicesRaw =
          p.dataSource === 'live' && Array.isArray(p.devices) && p.devices.length
            ? applyCacheToDevices(p.devices, cache)
            : current.devices
        // Re-infer type from model so new device UIs (e.g. ab-wheel) apply after upgrades
        const devices = devicesRaw.map((d) => {
          const nextType = inferDeviceType(d.model || '', d.name || d.nameKey || '')
          return nextType !== d.type ? { ...d, type: nextType } : d
        })
        const seedById = new Map(seedAutomations.map((a) => [a.id, a]))
        const automations = Array.isArray(p.automations)
          ? (p.automations as AutomationRule[]).map((a) => {
              const seed = seedById.get(a.id)
              const fromMap = AUTOMATION_LABELS[a.nameKey]
              const looksLikeI18nKey = /^(automation\.|[a-z]+[A-Z])/.test(a.nameKey || '')
              const nameKey =
                fromMap ||
                (looksLikeI18nKey ? seed?.nameKey : undefined) ||
                a.nameKey ||
                seed?.nameKey ||
                a.id
              return {
                ...a,
                nameKey,
                enabled: typeof a.enabled === 'boolean' ? a.enabled : Boolean(seed?.enabled),
              }
            })
          : current.automations
        return {
          ...current,
          ...p,
          customCategories,
          deviceCache: cache,
          capabilityCache,
          userProfile: p.dataSource === 'live' ? p.userProfile ?? null : null,
          userProfileFetchedAt:
            p.dataSource === 'live' ? p.userProfileFetchedAt ?? null : null,
          devices,
          automations,
          scenes:
            p.dataSource === 'live' && Array.isArray(p.scenes) ? p.scenes : current.scenes,
          rooms:
            p.dataSource === 'live' && Array.isArray(p.rooms) && p.rooms.length
              ? p.rooms
              : current.rooms,
        }
      },
    },
  ),
)
