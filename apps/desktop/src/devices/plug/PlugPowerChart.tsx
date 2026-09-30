import { useEffect, useMemo, useState } from 'react'
import { bridgeApi, type PlugPowerHistory, type PlugPowerPeriod } from '@/api/bridge'
import { PLUG_PERIOD_LABELS, pickLabel } from '@/labels'
import { useAppStore } from '@/stores/appStore'
import './plug-chart.css'

interface Props {
  deviceId: string
}

const PERIODS: PlugPowerPeriod[] = ['week', 'month', 'year']

function fmtKwh(v: number) {
  if (!Number.isFinite(v)) return '—'
  if (v > 0 && v < 0.1) return '<0.1'
  return v >= 10 ? v.toFixed(1) : v.toFixed(1)
}

function niceMax(max: number) {
  if (max <= 1) return 1
  if (max <= 2) return 2
  if (max <= 5) return 5
  if (max <= 10) return 10
  return Math.ceil(max / 5) * 5
}

function mockHistory(period: PlugPowerPeriod, offset: number): PlugPowerHistory {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const points: PlugPowerHistory['points'] = []
  if (period === 'week') {
    const end = new Date(now)
    end.setDate(end.getDate() + offset * 7)
    const start = new Date(end)
    start.setDate(start.getDate() - 6)
    const vals = [1.8, 2.4, 1.5, 3.2, 4.6, 2.1, 1.9]
    for (let i = 0; i < 7; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      points.push({
        time: Math.floor(d.getTime() / 1000),
        label: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
        value: vals[i],
      })
    }
    return {
      did: 'demo',
      period,
      offset,
      label: `${points[0].label}-${points[6].label}`,
      start: points[0].time,
      end: points[6].time,
      unit: 'kWh',
      total: Number(points.reduce((s, p) => s + p.value, 0).toFixed(1)),
      points,
      count: points.length,
    }
  }
  if (period === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    const days = offset === 0 ? now.getDate() : new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    for (let i = 1; i <= days; i++) {
      const day = new Date(d.getFullYear(), d.getMonth(), i)
      // Pattern similar to reference: valleys ~0.9–1.5, mid ~2–3, one peak ~4.8
      let value = 1.2 + (i % 7) * 0.25 + Math.sin(i / 3) * 0.6
      if (i === 13) value = 4.8
      else if (i === 22) value = 3.6
      else if (i % 9 === 0) value = 0.9
      points.push({
        time: Math.floor(day.getTime() / 1000),
        label: String(i).padStart(2, '0'),
        value: Number(Math.max(0.4, value).toFixed(2)),
      })
    }
    return {
      did: 'demo',
      period,
      offset,
      label: `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`,
      start: points[0]?.time ?? 0,
      end: points[points.length - 1]?.time ?? 0,
      unit: 'kWh',
      total: Number(points.reduce((s, p) => s + p.value, 0).toFixed(1)),
      points,
      count: points.length,
    }
  }
  const y = now.getFullYear() + offset
  const maxM = offset === 0 ? now.getMonth() + 1 : 12
  for (let m = 1; m <= maxM; m++) {
    const day = new Date(y, m - 1, 1)
    points.push({
      time: Math.floor(day.getTime() / 1000),
      label: String(m).padStart(2, '0'),
      value: Number((38 + m * 4 + (m === 7 ? 28 : 0) + (m % 3) * 6).toFixed(1)),
    })
  }
  return {
    did: 'demo',
    period,
    offset,
    label: String(y),
    start: points[0]?.time ?? 0,
    end: points[points.length - 1]?.time ?? 0,
    unit: 'kWh',
    total: Number(points.reduce((s, p) => s + p.value, 0).toFixed(1)),
    points,
    count: points.length,
  }
}

export function PlugPowerChart({ deviceId }: Props) {
    const dataSource = useAppStore((s) => s.dataSource)
  const showToast = useAppStore((s) => s.showToast)
  const [period, setPeriod] = useState<PlugPowerPeriod>('month')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<PlugPowerHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    setOffset(0)
  }, [period])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (dataSource !== 'live') {
        setData(mockHistory(period, offset))
        return
      }
      setLoading(true)
      try {
        const res = await bridgeApi.getPlugPowerHistory(deviceId, { period, offset })
        if (!cancelled) setData(res)
      } catch (err) {
        if (!cancelled) {
          showToast(err instanceof Error ? err.message : "用电历史加载失败")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [dataSource, deviceId, period, offset, showToast])

  const stats = useMemo(() => {
    const points = data?.points || []
    if (!points.length) {
      return { avg: 0, peak: 0, valley: 0, peakIdx: -1, valleyIdx: -1 }
    }
    let peakIdx = 0
    let valleyIdx = 0
    for (let i = 1; i < points.length; i++) {
      if (points[i].value > points[peakIdx].value) peakIdx = i
      if (points[i].value < points[valleyIdx].value) valleyIdx = i
    }
    const total = points.reduce((s, p) => s + p.value, 0)
    return {
      avg: total / points.length,
      peak: points[peakIdx].value,
      valley: points[valleyIdx].value,
      peakIdx,
      valleyIdx,
    }
  }, [data])

  const chart = useMemo(() => {
    const points = data?.points || []
    const W = 720
    const H = 260
    const pad = { top: 22, right: 16, bottom: 32, left: 36 }
    const innerW = W - pad.left - pad.right
    const innerH = H - pad.top - pad.bottom
    if (!points.length) {
      return {
        W,
        H,
        pad,
        bars: [] as {
          x: number
          y: number
          w: number
          h: number
          v: number
          label: string
          kind: 'normal' | 'peak' | 'active'
        }[],
        ticks: [] as number[],
        max: 1,
        xLabels: [] as { x: number; label: string }[],
        innerH,
      }
    }

    const max = niceMax(Math.max(...points.map((p) => p.value), 0.1))
    const n = points.length
    const gap = Math.max(3, Math.min(8, innerW / n / 4))
    const barW = Math.max(6, (innerW - gap * (n - 1)) / n)
    const activeIdx = hover != null ? hover : -1

    const bars = points.map((p, i) => {
      const h = Math.max((p.value / max) * innerH, 2)
      const x = pad.left + i * (barW + gap)
      const y = pad.top + innerH - h
      let kind: 'normal' | 'peak' | 'active' = 'normal'
      if (i === stats.peakIdx) kind = 'peak'
      if (i === activeIdx) kind = 'active'
      return { x, y, w: barW, h, v: p.value, label: p.label, kind }
    })

    const tickCount = Math.min(6, Math.max(3, Math.round(max) + 1))
    const ticks: number[] = []
    for (let i = 0; i < tickCount; i++) {
      ticks.push((max * i) / (tickCount - 1))
    }

    const labelCount = Math.min(6, n)
    const xLabels: { x: number; label: string }[] = []
    for (let i = 0; i < labelCount; i++) {
      const idx = labelCount === 1 ? 0 : Math.round((i / (labelCount - 1)) * (n - 1))
      xLabels.push({ x: bars[idx].x + bars[idx].w / 2, label: bars[idx].label })
    }

    return { W, H, pad, bars, ticks, max, xLabels, innerH }
  }, [data, hover, stats.peakIdx])

  const avgLabel =
    period === 'week'
      ? `本周日均 ${fmtKwh(stats.avg)} 度`
      : period === 'year'
        ? `本年月均 ${fmtKwh(stats.avg)} 度`
        : `本月日均 ${fmtKwh(stats.avg)} 度`

  return (
    <section className="panel plug-card-panel plug-history">
      <div className="plug-history-toolbar">
        <div className="plug-history-tabs" role="tablist">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={period === p}
              className={period === p ? 'active' : undefined}
              onClick={() => setPeriod(p)}
            >
              {pickLabel(PLUG_PERIOD_LABELS, p)}
            </button>
          ))}
        </div>
        <div className="plug-history-nav">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={loading}
            onClick={() => setOffset((v) => v - 1)}
            aria-label="prev"
          >
            ‹
          </button>
          <strong>{data?.label || '—'}</strong>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={loading || offset >= 0}
            onClick={() => setOffset((v) => Math.min(0, v + 1))}
            aria-label="next"
          >
            ›
          </button>
        </div>
      </div>

      <div className="plug-chart-summary">
        <div className="plug-chart-summary-main">
          <div className="plug-chart-total">
            <strong>{fmtKwh(data?.total ?? 0)}</strong>
            <small>度</small>
          </div>
          <p className="plug-chart-avg">{avgLabel}</p>
          {hover != null && data?.points[hover] ? (
            <p className="plug-chart-hover">
              {data.points[hover].label}: {fmtKwh(data.points[hover].value)} 度
            </p>
          ) : null}
        </div>
        <div className="plug-chart-minmax">
          <div className="plug-chart-stat peak">
            <span>峰值</span>
            <strong>
              {fmtKwh(stats.peak)}
              度
            </strong>
          </div>
          <div className="plug-chart-stat valley">
            <span>谷值</span>
            <strong>
              {fmtKwh(stats.valley)}
              度
            </strong>
          </div>
        </div>
      </div>

      {loading && !data ? (
        <p className="meta soft">正在同步…</p>
      ) : !chart.bars.length ? (
        <p className="meta soft">暂无用电记录</p>
      ) : (
        <svg
          className="plug-history-svg"
          viewBox={`0 0 ${chart.W} ${chart.H}`}
          role="img"
          aria-label="用电趋势"
          onMouseLeave={() => setHover(null)}
        >
          {chart.ticks.map((tick, i) => {
            const y =
              chart.pad.top + ((chart.max - tick) / (chart.max || 1)) * chart.innerH
            return (
              <g key={i}>
                <line
                  x1={chart.pad.left}
                  x2={chart.W - chart.pad.right}
                  y1={y}
                  y2={y}
                  className="plug-history-grid"
                />
                <text x={chart.pad.left - 8} y={y + 4} textAnchor="end" className="plug-history-axis">
                  {tick % 1 === 0 ? tick : tick.toFixed(1)}
                </text>
              </g>
            )
          })}

          {chart.xLabels.map((l, i) => (
            <text key={i} x={l.x} y={chart.H - 10} textAnchor="middle" className="plug-history-axis">
              {l.label}
            </text>
          ))}

          {chart.bars.map((b, i) => (
            <g key={i} onMouseEnter={() => setHover(i)} style={{ cursor: 'pointer' }}>
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={Math.min(10, b.w / 2)}
                ry={Math.min(10, b.w / 2)}
                className={`plug-history-bar ${b.kind}`}
              />
              {b.kind === 'peak' ? (
                <circle
                  cx={b.x + b.w / 2}
                  cy={b.y - 6}
                  r={4.5}
                  className="plug-history-peak-dot"
                />
              ) : null}
              {/* hit area */}
              <rect
                x={b.x - 2}
                y={chart.pad.top}
                width={b.w + 4}
                height={chart.innerH}
                fill="transparent"
              />
            </g>
          ))}
        </svg>
      )}
    </section>
  )
}
