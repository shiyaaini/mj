import { useMemo, useState } from 'react'
import type { AbwheelTrendPoint } from '@/api/bridge'

export type AbwheelPeriod = 'week' | 'month' | 'year' | 'all'
export type TrendMetric = 'count' | 'calories' | 'durationSec'

interface Props {
  points: AbwheelTrendPoint[]
  period: AbwheelPeriod
  metric: TrendMetric
  onMetricChange: (m: TrendMetric) => void
  label?: string
  offset?: number
  onOffsetChange?: (next: number) => void
  navDisabled?: boolean
}

const METRICS: { id: TrendMetric; label: string; unit: string }[] = [
  { id: 'count', label: '次数', unit: '次' },
  { id: 'calories', label: '热量', unit: 'kcal' },
  { id: 'durationSec', label: '时长', unit: '分' },
]

function niceMax(v: number) {
  if (!Number.isFinite(v) || v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  const n = v / mag
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * mag
}

function fmtLabel(ms: number, period: AbwheelPeriod) {
  const d = new Date(ms)
  if (period === 'year' || period === 'all') {
    return `${d.getMonth() + 1}月`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function metricValue(p: AbwheelTrendPoint, metric: TrendMetric) {
  if (metric === 'durationSec') return (p.durationSec || 0) / 60
  if (metric === 'calories') return p.calories || 0
  return p.count || 0
}

function fmtValue(v: number, metric: TrendMetric) {
  if (metric === 'calories') return v.toFixed(1)
  if (metric === 'durationSec') return v.toFixed(0)
  return String(Math.round(v))
}

export function AbWheelTrendChart({
  points,
  period,
  metric,
  onMetricChange,
  label,
  offset = 0,
  onOffsetChange,
  navDisabled,
}: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const meta = METRICS.find((m) => m.id === metric) || METRICS[0]
  const showNav = period !== 'all' && !!onOffsetChange

  const chart = useMemo(() => {
    const W = 720
    const H = 220
    const pad = { top: 18, right: 14, bottom: 28, left: 36 }
    const innerW = W - pad.left - pad.right
    const innerH = H - pad.top - pad.bottom
    const values = points.map((p) => metricValue(p, metric))
    const max = niceMax(Math.max(...values, 0.1))
    const n = points.length
    if (!n) {
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
          kind: 'normal' | 'peak' | 'active' | 'empty'
          date: number
        }[],
        ticks: [] as number[],
        max,
        xLabels: [] as { x: number; label: string }[],
        innerH,
      }
    }
    const gap = Math.max(2, Math.min(8, innerW / n / 4))
    const barW = Math.max(4, (innerW - gap * (n - 1)) / n)
    const peakIdx = values.reduce(
      (best, v, i) => (v > values[best] ? i : best),
      0,
    )
    const bars = points.map((p, i) => {
      const v = values[i]
      const h = Math.max((v / max) * innerH, v > 0 ? 2 : 0)
      const x = pad.left + i * (barW + gap)
      const y = pad.top + innerH - h
      let kind: 'normal' | 'peak' | 'active' | 'empty' = v > 0 ? 'normal' : 'empty'
      if (i === peakIdx && v > 0) kind = 'peak'
      if (i === hover) kind = 'active'
      return {
        x,
        y,
        w: barW,
        h,
        v,
        label: fmtLabel(p.date, period),
        kind,
        date: p.date,
      }
    })
    const ticks = [0, 0.5, 1].map((t) => max * t)
    const labelCount = Math.min(
      period === 'month' ? 8 : period === 'week' ? 7 : 6,
      n,
    )
    const xLabels: { x: number; label: string }[] = []
    for (let i = 0; i < labelCount; i++) {
      const idx =
        labelCount === 1 ? 0 : Math.round((i / (labelCount - 1)) * (n - 1))
      xLabels.push({
        x: bars[idx].x + bars[idx].w / 2,
        label: bars[idx].label,
      })
    }
    return { W, H, pad, bars, ticks, max, xLabels, innerH }
  }, [points, period, metric, hover])

  const hoverBar = hover != null ? chart.bars[hover] : null

  return (
    <div className="abwheel-trend">
      <div className="abwheel-trend-head">
        <h3>训练趋势</h3>
        <div className="abwheel-metric-tabs" role="tablist">
          {METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={metric === m.id}
              className={metric === m.id ? 'active' : undefined}
              onClick={() => onMetricChange(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {showNav ? (
        <div className="abwheel-period-nav">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={navDisabled}
            onClick={() => onOffsetChange?.(offset - 1)}
            aria-label="上一周期"
          >
            ‹
          </button>
          <strong>{label || '—'}</strong>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={navDisabled || offset >= 0}
            onClick={() => onOffsetChange?.(Math.min(0, offset + 1))}
            aria-label="下一周期"
          >
            ›
          </button>
        </div>
      ) : null}

      {!points.length ? (
        <p className="abwheel-empty">当前筛选下暂无趋势数据</p>
      ) : (
        <>
          <div className="abwheel-trend-hover">
            {hoverBar ? (
              <>
                <strong>{hoverBar.label}</strong>
                <span>
                  {fmtValue(hoverBar.v, metric)} {meta.unit}
                </span>
              </>
            ) : (
              <span className="soft">悬停查看各点数值</span>
            )}
          </div>
          <svg
            className="abwheel-trend-svg"
            viewBox={`0 0 ${chart.W} ${chart.H}`}
            role="img"
            aria-label="健腹轮训练趋势"
          >
            {chart.ticks.map((tick, i) => {
              const y =
                chart.pad.top +
                ((chart.max - tick) / (chart.max || 1)) * chart.innerH
              return (
                <g key={i}>
                  <line
                    x1={chart.pad.left}
                    x2={chart.W - chart.pad.right}
                    y1={y}
                    y2={y}
                    className="abwheel-trend-grid"
                  />
                  <text
                    x={chart.pad.left - 8}
                    y={y + 4}
                    textAnchor="end"
                    className="abwheel-trend-axis"
                  >
                    {fmtValue(tick, metric)}
                  </text>
                </g>
              )
            })}
            {chart.xLabels.map((l, i) => (
              <text
                key={i}
                x={l.x}
                y={chart.H - 8}
                textAnchor="middle"
                className="abwheel-trend-axis"
              >
                {l.label}
              </text>
            ))}
            {chart.bars.map((b, i) =>
              b.h > 0 ? (
                <rect
                  key={i}
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  rx={3}
                  className={`abwheel-trend-bar ${b.kind}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ) : (
                <rect
                  key={i}
                  x={b.x}
                  y={chart.pad.top + chart.innerH - 2}
                  width={b.w}
                  height={2}
                  rx={1}
                  className="abwheel-trend-bar empty"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ),
            )}
          </svg>
        </>
      )}
    </div>
  )
}
