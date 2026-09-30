import { useEffect, useMemo, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { bridgeApi, type DeviceCapabilities, type DevicePropMeta } from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import {
  buildSliderModel,
  cleanEnumLabel,
  effectivePropRw,
  formatPropDisplayValue,
  formatSliderValue,
  schemaMissingAccess,
  shouldShowAdjustProp,
} from '@/lib/propFormat'
import { useAppStore } from '@/stores/appStore'
import './detail.css'
import { DetailPowerButton, isPowerLikeProp, isPrimaryPowerProp } from './DetailPowerButton'

export function canWrite(prop: DevicePropMeta) {
  return effectivePropRw(prop).includes('w')
}

export function canRead(prop: DevicePropMeta) {
  return effectivePropRw(prop).includes('r')
}

function isOnOffEnum(prop: DevicePropMeta) {
  const list = prop.value_list || []
  if (list.length < 2) return false
  const labels = list.map((i) => cleanEnumLabel(i.description || '').toLowerCase())
  const hasOn = labels.some((l) => l === 'on' || l.includes('开启') || l === 'open')
  const hasOff = labels.some((l) => l === 'off' || l.includes('关闭') || l === 'close')
  return hasOn && hasOff
}

function onOffValues(prop: DevicePropMeta) {
  const list = prop.value_list || []
  let onVal: unknown = 1
  let offVal: unknown = 0
  for (const item of list) {
    const label = cleanEnumLabel(item.description || '').toLowerCase()
    if (label === 'on' || label.includes('开启') || label === 'open') onVal = item.value
    if (label === 'off' || label.includes('关闭') || label === 'close') offVal = item.value
  }
  return { onVal, offVal }
}

export function propLabel(prop: DevicePropMeta) {
  const desc = prop.desc || prop.name
  const parts = desc.split('/').map((s) => s.trim()).filter(Boolean)
  const label = parts[parts.length - 1] || prop.name
  return cleanEnumLabel(label)
}

/** Prefer unique titles when Spec reuses the same desc across services (mode / mode-5). */
export function uniquePropLabel(prop: DevicePropMeta, siblings: DevicePropMeta[]) {
  const base = propLabel(prop)
  const dup = siblings.filter((p) => propLabel(p) === base).length > 1
  if (!dup) return base
  const suffix = prop.name.match(/-(\d+)$/)?.[1]
  if (suffix) return `${base} · ${suffix}`
  return `${base} · ${prop.name}`
}

export function normalizePropKey(name: string) {
  return name.replace(/_/g, '-').toLowerCase()
}

export function isPropExcluded(name: string, exclude: Iterable<string>) {
  const n = normalizePropKey(name)
  for (const e of exclude) {
    if (normalizePropKey(e) === n) return true
  }
  return false
}

/** Stable default — inline `= []` creates a new array each render and can loop setState */
const EMPTY_EXCLUDE: string[] = []

interface Props {
  device: Device
  /** Props already covered by the type-specific template UI */
  excludeNames?: string[]
  /** When true, show as expandable "全部能力" under a template */
  asSupplement?: boolean
  /** @deprecated Hero power is always a single main switch now */
  primarySwitchLimit?: number
}

/**
 * Full MIoT Spec controls for any device.
 * Maps Spec types to widgets: bool→toggle, enum→chips, range→slider, action→trigger.
 */
export function DeviceCapabilityPanel({
  device,
  excludeNames = EMPTY_EXCLUDE,
  asSupplement = false,
}: Props) {
    const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cachedEntry = useAppStore((s) => s.capabilityCache[device.id])
  const rememberCapabilities = useAppStore((s) => s.rememberCapabilities)
  const refreshDeviceCapabilities = useAppStore((s) => s.refreshDeviceCapabilities)
  const patchDevicePreview = useAppStore((s) => s.patchDevicePreview)
  const showToast = useAppStore((s) => s.showToast)

  const [caps, setCaps] = useState<DeviceCapabilities | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [uiSliders, setUiSliders] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState(!asSupplement)

  const excludeKey = excludeNames.join('\0')
  // Depend on excludeKey only — default/`[]` identity must not retrigger memos
  const exclude = useMemo(() => new Set(excludeNames), [excludeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hydrated) return
    if (!cachedEntry?.caps) return
    setCaps(cachedEntry.caps)
    setValues(cachedEntry.caps.values || {})
    setLoading(false)
  }, [hydrated, cachedEntry])

  useEffect(() => {
    if (!hydrated) return
    if (dataSource !== 'live') {
      setCaps(null)
      setValues(device.preview ?? {})
      setLoading(false)
      return
    }
    let cancelled = false
    const load = async () => {
      const cached = useAppStore.getState().capabilityCache[device.id]
      const hadCache = Boolean(cached?.caps)
      const forceSchema = schemaMissingAccess(cached?.caps)
      if (hadCache && !forceSchema) {
        setLoading(false)
        setSyncing(true)
      } else {
        setLoading(true)
      }
      try {
        await refreshDeviceCapabilities(device.id, forceSchema)
      } finally {
        if (!cancelled) {
          setLoading(false)
          setSyncing(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [hydrated, dataSource, device.id, device.preview, refreshDeviceCapabilities])

  const properties = useMemo(
    () => (caps?.properties || []).filter((p) => !isPropExcluded(p.name, exclude)),
    [caps, exclude],
  )

  const writableBools = useMemo(
    () => properties.filter((p) => p.type === 'bool' && canWrite(p)),
    [properties],
  )

  const heroPower = useMemo(() => {
    const exact = writableBools.find((p) => isPrimaryPowerProp(p.name))
    if (exact) return exact
    // Fallback: first writable bool if nothing named on/power/switch
    return asSupplement ? undefined : writableBools[0]
  }, [writableBools, asSupplement])

  /** Diffuser-style devices expose On/Off as uint enum `status` instead of bool `on`. */
  const statusPower = useMemo(() => {
    if (heroPower || asSupplement) return undefined
    return properties.find(
      (p) =>
        normalizePropKey(p.name) === 'status' && canWrite(p) && isOnOffEnum(p),
    )
  }, [properties, heroPower, asSupplement])

  const toggleBools = useMemo(
    () => writableBools.filter((p) => !heroPower || p.name !== heroPower.name),
    [writableBools, heroPower],
  )

  const enums = useMemo(
    () =>
      properties.filter(
        (p) =>
          canWrite(p) &&
          Array.isArray(p.value_list) &&
          p.value_list.length > 0 &&
          !/scene|flex/i.test(p.name) &&
          (!statusPower || p.name !== statusPower.name),
      ),
    [properties, statusPower],
  )

  const adjustProps = useMemo(() => {
    return properties
      .filter(
        (p) =>
          ['int', 'uint', 'float'].includes(p.type) &&
          canWrite(p) &&
          !(Array.isArray(p.value_list) && p.value_list.length > 0) &&
          shouldShowAdjustProp(p),
      )
      .map((prop) => {
        const model = buildSliderModel(prop, values[prop.name])
        return model ? { prop, model } : null
      })
      .filter(Boolean) as {
      prop: DevicePropMeta
      model: NonNullable<ReturnType<typeof buildSliderModel>>
    }[]
  }, [properties, values])

  useEffect(() => {
    const next: Record<string, number> = {}
    for (const { prop, model } of adjustProps) {
      next[prop.name] = model.toUi(Number(values[prop.name]))
    }
    setUiSliders((prev) => {
      const keys = Object.keys(next)
      if (
        keys.length === Object.keys(prev).length &&
        keys.every((k) => prev[k] === next[k])
      ) {
        return prev
      }
      return next
    })
  }, [adjustProps, values])

  const readonlyProps = useMemo(
    () =>
      properties.filter(
        (p) =>
          canRead(p) &&
          !canWrite(p) &&
          !/scene|chip|unix/i.test(p.name),
      ),
    [properties],
  )

  const actions = useMemo(
    () =>
      (caps?.actions || []).filter((a) => {
        if (isPropExcluded(a.name, exclude)) return false
        // Skip redundant toggle when a main power switch already exists
        if (/^toggle$/i.test(a.name) && (heroPower || statusPower)) return false
        return true
      }),
    [caps, exclude, heroPower, statusPower],
  )

  const hasAnything =
    writableBools.length > 0 ||
    Boolean(statusPower) ||
    enums.length > 0 ||
    adjustProps.length > 0 ||
    readonlyProps.length > 0 ||
    actions.length > 0

  const setPropValue = async (name: string, value: unknown) => {
    const prev = values[name]
    const nextValues = { ...values, [name]: value }
    setValues(nextValues)
    if (caps) {
      rememberCapabilities(device.id, { ...caps, values: nextValues })
    }
    setBusy(name)
    try {
      if (dataSource === 'live') {
        await bridgeApi.setProp(device.id, name, value)
      }
      if (isPowerLikeProp(name) && isPrimaryPowerProp(name)) {
        patchDevicePreview(device.id, { power: Boolean(value) })
      } else if (normalizePropKey(name) === 'status' && caps) {
        const prop = caps.properties.find((p) => p.name === name)
        if (prop && isOnOffEnum(prop)) {
          const { onVal } = onOffValues(prop)
          patchDevicePreview(device.id, { power: String(value) === String(onVal) })
        }
      }
    } catch (err) {
      const rolled = { ...values, [name]: prev }
      setValues(rolled)
      if (caps) rememberCapabilities(device.id, { ...caps, values: rolled })
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  const runAction = async (name: string) => {
    setBusy(name)
    try {
      if (dataSource === 'live') {
        await bridgeApi.runDeviceAction(device.id, name)
      }
      showToast("动作已执行")
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy(null)
    }
  }

  if (dataSource === 'mock' && asSupplement) {
    return null
  }

  if (asSupplement && !loading && !syncing && !hasAnything) {
    return null
  }

  const sectionClass = asSupplement ? 'caps-section' : 'panel'
  const hasCache = Boolean(cachedEntry?.caps)

  const powerButton = !asSupplement && (heroPower || statusPower) ? (
      <div className="detail-power-wrap">
        {heroPower ? (
          <DetailPowerButton
            on={Boolean(values[heroPower.name])}
            size="md"
            label={Boolean(values[heroPower.name]) ? "已开启" : "已关闭"}
            busy={busy === heroPower.name}
            onClick={() => void setPropValue(heroPower.name, !Boolean(values[heroPower.name]))}
          />
        ) : statusPower ? (
          (() => {
            const { onVal, offVal } = onOffValues(statusPower)
            const on = String(values[statusPower.name] ?? offVal) === String(onVal)
            return (
              <DetailPowerButton
                on={on}
                size="md"
                label={on ? "已开启" : "已关闭"}
                busy={busy === statusPower.name}
                onClick={() => void setPropValue(statusPower.name, on ? offVal : onVal)}
              />
            )
          })()
        ) : null}
      </div>
    ) : null

  const switchesList =
    toggleBools.length > 0 ? (
      <div className="control-stack">
        {toggleBools.map((prop) => {
          const on = Boolean(values[prop.name])
          return (
            <button
              key={prop.name}
              type="button"
              className={`power-toggle${on ? ' on' : ''}`}
              disabled={busy === prop.name}
              onClick={() => void setPropValue(prop.name, !on)}
            >
              <span className="power-knob" />
              <div className="power-copy">
                <strong>{uniquePropLabel(prop, toggleBools)}</strong>
                <small>{on ? "已开启" : "已关闭"}</small>
              </div>
            </button>
          )
        })}
      </div>
    ) : null

  const statusSection =
    readonlyProps.length > 0 ? (
      <div className={sectionClass}>
        <h2>状态</h2>
        <div className="metrics-grid">
          {readonlyProps.map((prop) => (
            <div key={prop.name} className="metric-chip">
              <span>{uniquePropLabel(prop, readonlyProps)}</span>
              <strong>{formatPropDisplayValue(prop, values[prop.name])}</strong>
            </div>
          ))}
        </div>
      </div>
    ) : null

  const enumsSection =
    enums.length > 0 ? (
      <div className={sectionClass}>
        <h2>模式与选项</h2>
        {enums.map((prop) => (
          <div key={prop.name} className="prop-block">
            <div className="prop-title">{uniquePropLabel(prop, enums)}</div>
            <div className="mode-chip-row" role="group" aria-label={uniquePropLabel(prop, enums)}>
              {(prop.value_list || []).map((item) => {
                const active = String(values[prop.name]) === String(item.value)
                return (
                  <button
                    key={`${prop.name}-${item.value}`}
                    type="button"
                    className={`mode-chip${active ? ' active' : ''}`}
                    disabled={busy === prop.name}
                    onClick={() => void setPropValue(prop.name, item.value)}
                  >
                    {cleanEnumLabel(item.description || String(item.value))}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    ) : null

  const adjustSection =
    adjustProps.length > 0 ? (
      <div className={`${sectionClass} adjust-panel`}>
        <h2>调节</h2>
        <div className="adjust-list">
          {adjustProps.map(({ prop, model }) => {
            const ui = uiSliders[prop.name] ?? model.toUi(Number(values[prop.name]))
            const pct =
              model.max === model.min
                ? 0
                : ((ui - model.min) / (model.max - model.min)) * 100
            return (
              <div key={prop.name} className="adjust-card">
                <div className="adjust-head">
                  <span>{uniquePropLabel(prop, adjustProps.map((a) => a.prop))}</span>
                  <strong>{formatSliderValue(ui, model)}</strong>
                </div>
                <div className="adjust-track-wrap">
                  <input
                    className="adjust-slider"
                    type="range"
                    min={model.min}
                    max={model.max}
                    step={model.step}
                    value={ui}
                    disabled={busy === prop.name}
                    style={{
                      background: `linear-gradient(90deg, var(--accent) ${pct}%, #e6ebf2 ${pct}%)`,
                    }}
                    onChange={(e) => {
                      const next = Number(e.target.value)
                      setUiSliders((s) => ({ ...s, [prop.name]: next }))
                    }}
                    onMouseUp={(e) => {
                      const next = Number((e.target as HTMLInputElement).value)
                      void setPropValue(prop.name, model.toDevice(next))
                    }}
                    onTouchEnd={(e) => {
                      const next = Number((e.target as HTMLInputElement).value)
                      void setPropValue(prop.name, model.toDevice(next))
                    }}
                  />
                </div>
                <div className="adjust-scale">
                  <span>{formatSliderValue(model.min, model)}</span>
                  <span>{formatSliderValue(model.max, model)}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    ) : null

  const switchesSection =
    !asSupplement && switchesList ? (
      <div className={sectionClass}>
        <h2>开关</h2>
        {switchesList}
      </div>
    ) : null

  const actionsSection =
    actions.length > 0 ? (
      <div className={sectionClass}>
        <h2>动作</h2>
        <div className="action-trigger-row">
          {actions.map((action) => {
            const needsParams = Boolean(action.in?.length)
            return (
              <button
                key={action.name}
                type="button"
                className={`action-trigger-btn${needsParams ? ' has-params' : ''}`}
                disabled={busy === action.name}
                title={
                  needsParams
                    ? `将自动填充 ${action.in!.length} 个参数：${action.in!.map((p) => p.desc || p.name).join(', ')}`
                    : action.desc || action.name
                }
                onClick={() => void runAction(action.name)}
              >
                <span className="action-trigger-icon" aria-hidden>
                  ▶
                </span>
                <span className="action-trigger-copy">
                  <strong>{cleanEnumLabel(action.desc || action.name)}</strong>
                  <small>执行</small>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    ) : null

  // Layout: status → options → adjust → switches → actions
  const restBody = (
    <>
      {statusSection}
      {enumsSection}
      {adjustSection}
      {asSupplement && writableBools.length > 0 ? (
        <div className={sectionClass}>
          <h2>开关</h2>
          <div className="control-stack">
            {writableBools.map((prop) => {
              const on = Boolean(values[prop.name])
              return (
                <button
                  key={prop.name}
                  type="button"
                  className={`power-toggle${on ? ' on' : ''}`}
                  disabled={busy === prop.name}
                  onClick={() => void setPropValue(prop.name, !on)}
                >
                  <span className="power-knob" />
                  <div className="power-copy">
                    <strong>{uniquePropLabel(prop, writableBools)}</strong>
                    <small>{on ? "已开启" : "已关闭"}</small>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        switchesSection
      )}
      {actionsSection}
    </>
  )

  if (asSupplement) {
    return (
      <section className="panel plug-card-panel caps-supplement">
        <button
          type="button"
          className="caps-supplement-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          <div>
            <strong>全部能力</strong>
            <p className="meta soft">基于设备 Spec 的完整属性与动作，避免模板未覆盖的功能丢失</p>
          </div>
          <span className="caps-supplement-chevron">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded ? (
          <div className="caps-supplement-body">
            {syncing || loading ? (
              <p className="meta soft">正在同步…</p>
            ) : null}
            {restBody}
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <div className="detail-layout caps-panel">
      <section className="panel hero-panel">
        {!hydrated || loading ? (
          <p className="meta">正在同步米家数据…</p>
        ) : syncing ? (
          <p className="meta soft">正在同步…</p>
        ) : hasCache ? (
          <p className="meta soft">已显示上次状态</p>
        ) : null}
        {powerButton}
        {hydrated && !loading && !writableBools.length && !hasAnything ? (
          <p className="empty">未发现可写控制项</p>
        ) : null}
      </section>
      {restBody}
    </div>
  )
}
