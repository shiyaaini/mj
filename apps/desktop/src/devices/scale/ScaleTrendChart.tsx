import { useId, useMemo, useState } from 'react'
import type { ScaleRecord } from '@/api/bridge'

export type TrendMetric = 'weight' | 'bmi' | 'bodyFat' | 'muscleMass'

interface Point {
  t: number
  v: number
}

interface Props {
  records: ScaleRecord[]
  metric: TrendMetric
  onMetricChange: (m: TrendMetric) => void
  locale: string
}

const METRICS: { id: TrendMetric; label: string; unit: string; digits: number }[] = [
  { id: 'weight', label: '体重', unit: 'kg', digits: 1 },
  { id: 'bmi', label: 'BMI', unit: '', digits: 1 },
  { id: 'bodyFat', label: '体脂率', unit: '%', digits: 1 },
  { id: 'muscleMass', label: '肌肉量', unit: 'kg', digits: 1 },
]

const MAX_POINTS = 36

function readMetric(r: ScaleRecord, metric: TrendMetric): number | null {
  const raw = r[metric]
  if (raw == null || !Number.isFinite(Number(raw))) return null
  return Number(raw)
}

function fmtAxisDate(ms: number, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }).format(
      new Date(ms),
    )
  } catch {
    const d = new Date(ms)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
}

function niceRange(min: number, max: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.02, 0.5)
    return { min: min - pad, max: max + pad }
  }
  const span = max - min
  const pad = Math.max(span * 0.15, 0.3)
  return { min: min - pad, max: max + pad }
}

/** One point per calendar day (average), oldest → newest. */
function aggregateByDay(points: Point[]): Point[] {
  const map = new Map<string, { sum: number; n: number; t: number }>()
  for (const p of points) {
    const d = new Date(p.t)
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const cur = map.get(key) || { sum: 0, n: 0, t: p.t }
    cur.sum += p.v
    cur.n += 1
    cur.t = Math.max(cur.t, p.t)
    map.set(key, cur)
  }
  return [...map.values()]
    .sort((a, b) => a.t - b.t)
    .map((v) => ({ t: v.t, v: v.sum / v.n }))
}

function downsample(points: Point[], max: number): Point[] {
  if (points.length <= max) return points
  const out: Point[] = []
  const last = points.length - 1
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i / (max - 1)) * last)
    const p = points[idx]
    if (!out.length || out[out.length - 1].t !== p.t) out.push(p)
  }
  return out
}

/** Catmull-Rom → cubic Bezier path. */
function smoothPath(xs: number[], ys: number[]): string {
  if (!xs.length) return ''
  if (xs.length === 1) return `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`
  if (xs.length === 2) {
    return `M${xs[0].toFixed(1)},${ys[0].toFixed(1)} L${xs[1].toFixed(1)},${ys[1].toFixed(1)}`
  }
  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i - 1] ?? xs[i]
    const y0 = ys[i - 1] ?? ys[i]
    const x1 = xs[i]
    const y1 = ys[i]
    const x2 = xs[i + 1]
    const y2 = ys[i + 1]
    const x3 = xs[i + 2] ?? x2
    const y3 = ys[i + 2] ?? y2
    const cp1x = x1 + (x2 - x0) / 6
    const cp1y = y1 + (y2 - y0) / 6
    const cp2x = x2 - (x3 - x1) / 6
    const cp2y = y2 - (y3 - y1) / 6
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
  }
  return d
}

export function ScaleTrendChart({ records, metric, onMetricChange, locale }: Props) {
    const gradId = useId().replace(/:/g, '')
  const [hover, setHover] = useState<number | null>(null)
  const meta = METRICS.find((m) => m.id === metric) || METRICS[0]

  const points = useMemo(() => {
    const raw: Point[] = []
    for (const r of [...records].reverse()) {
      const v = readMetric(r, metric)
      if (v == null || !r.createTime) continue
      raw.push({ t: r.createTime, v })
    }
    return downsample(aggregateByDay(raw), MAX_POINTS)
  }, [records, metric])

  const chart = useMemo(() => {
    const W = 720
    const H = 248
    const pad = { top: 20, right: 20, bottom: 32, left: 48 }
    const innerW = W - pad.left - pad.right
    const innerH = H - pad.top - pad.bottom

    if (points.length === 0) {
      return {
        W,
        H,
        pad,
        innerW,
        innerH,
        path: '',
        area: '',
        xs: [] as number[],
        ys: [] as number[],
        yTicks: [] as number[],
        xLabels: [] as { x: number; label: string }[],
        yMin: 0,
        yMax: 1,
      }
    }

    const vals = points.map((p) => p.v)
    const { min: yMin, max: yMax } = niceRange(Math.min(...vals), Math.max(...vals))
    // Even spacing on index (not raw timestamps) so dense days don't crush the line
    const xs = points.map((_, i) =>
      points.length === 1
        ? pad.left + innerW / 2
        : pad.left + (i / (points.length - 1)) * innerW,
    )
    const ys = points.map(
      (p) => pad.top + ((yMax - p.v) / (yMax - yMin || 1)) * innerH,
    )

    const path = smoothPath(xs, ys)
    const area = `${path} L${xs[xs.length - 1].toFixed(1)},${(pad.top + innerH).toFixed(1)} L${xs[0].toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`

    const yTicks: number[] = []
    for (let i = 0; i < 4; i++) {
      yTicks.push(yMin + ((yMax - yMin) * i) / 3)
    }

    const labelCount = Math.min(5, points.length)
    const xLabels: { x: number; label: string }[] = []
    for (let i = 0; i < labelCount; i++) {
      const idx =
        labelCount === 1 ? 0 : Math.round((i / (labelCount - 1)) * (points.length - 1))
      xLabels.push({ x: xs[idx], label: fmtAxisDate(points[idx].t, locale) })
    }

    return { W, H, pad, innerW, innerH, path, area, xs, ys, yTicks, xLabels, yMin, yMax }
  }, [points, locale])

  const hiIdx = hover != null ? hover : points.length ? points.length - 1 : -1
  const hi = hiIdx >= 0 ? points[hiIdx] : null
  const hiX = hiIdx >= 0 ? chart.xs[hiIdx] : undefined
  const hiY = hiIdx >= 0 ? chart.ys[hiIdx] : undefined

  return (
    <div className="scale-trend">
      <div className="scale-trend-head">
        <h3>趋势</h3>
        <div className="scale-trend-tabs" role="tablist">
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

      {points.length === 0 ? (
        <p className="scale-empty">记录不足，暂无法绘制趋势</p>
      ) : (
        <>
          <div className="scale-trend-summary">
            <strong>
              {hi ? hi.v.toFixed(meta.digits) : '—'}
              {meta.unit ? <small>{meta.unit}</small> : null}
            </strong>
            <span>
              {hi ? fmtAxisDate(hi.t, locale) : ''}
              {points.length > 1 ? ` · ${points.length} 次记录` : ''}
            </span>
          </div>

          <svg
            className="scale-trend-svg"
            viewBox={`0 0 ${chart.W} ${chart.H}`}
            role="img"
            aria-label="趋势"
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={`g-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {chart.yTicks.map((tick, i) => {
              const y =
                chart.pad.top +
                ((chart.yMax - tick) / (chart.yMax - chart.yMin || 1)) * chart.innerH
              return (
                <g key={i}>
                  <line
                    x1={chart.pad.left}
                    x2={chart.pad.left + chart.innerW}
                    y1={y}
                    y2={y}
                    className="scale-trend-grid"
                  />
                  <text
                    x={chart.pad.left - 10}
                    y={y + 4}
                    textAnchor="end"
                    className="scale-trend-axis"
                  >
                    {tick.toFixed(1)}
                  </text>
                </g>
              )
            })}

            {chart.xLabels.map((l, i) => (
              <text key={i} x={l.x} y={chart.H - 10} textAnchor="middle" className="scale-trend-axis">
                {l.label}
              </text>
            ))}

            <path d={chart.area} fill={`url(#g-${gradId})`} />
            <path d={chart.path} className="scale-trend-line" />

            {hi != null && hiX != null && hiY != null ? (
              <>
                <line
                  x1={hiX}
                  x2={hiX}
                  y1={chart.pad.top}
                  y2={chart.pad.top + chart.innerH}
                  className="scale-trend-cross"
                />
                <circle cx={hiX} cy={hiY} r={6} className="scale-trend-dot active" />
              </>
            ) : null}

            {chart.xs.map((x, i) => {
              const slot = Math.max(chart.innerW / Math.max(points.length, 1), 20)
              return (
                <rect
                  key={`hit-${i}`}
                  x={x - slot / 2}
                  y={chart.pad.top}
                  width={slot}
                  height={chart.innerH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              )
            })}
          </svg>
        </>
      )}
    </div>
  )
}
