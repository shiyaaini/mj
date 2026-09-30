import { useEffect, useMemo, useState } from 'react'
import type { Device } from '@mi-home/shared'
import {
  bridgeApi,
  type AbwheelRecord,
  type AbwheelSummary,
  type AbwheelTotals,
  type AbwheelTrendPoint,
  type AbwheelTrends,
} from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { useAppStore } from '@/stores/appStore'
import {
  AbWheelTrendChart,
  type AbwheelPeriod,
  type TrendMetric,
} from './AbWheelTrendChart'
import './abwheel.css'

interface Props {
  device: Device
}

const PERIODS: { id: AbwheelPeriod; label: string }[] = [
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
  { id: 'year', label: '年' },
  { id: 'all', label: '全部' },
]

function mockSeries(): AbwheelRecord[] {
  const now = Date.now()
  return [
    {
      id: '1',
      did: 'abwheel-1',
      startTime: now - 2 * 3600_000,
      durationSec: 420,
      count: 48,
      calories: 36.2,
      title: '健腹轮训练',
    },
    {
      id: '2',
      did: 'abwheel-1',
      startTime: now - 26 * 3600_000,
      durationSec: 360,
      count: 40,
      calories: 29.5,
      title: '健腹轮训练',
    },
    {
      id: '3',
      did: 'abwheel-1',
      startTime: now - 3 * 86400_000,
      durationSec: 510,
      count: 55,
      calories: 41.0,
      title: '健腹轮训练',
    },
  ]
}

function fmtNum(v: number | null | undefined, digits = 0) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return Number(v).toFixed(digits)
}

function fmtDuration(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—'
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m <= 0) return `${r} 秒`
  if (r === 0) return `${m} 分钟`
  return `${m} 分 ${r} 秒`
}

function fmtTime(ms: number) {
  if (!ms) return '—'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toLocaleString()
  }
}

function weekBounds(offset = 0) {
  const d = new Date()
  const day = (d.getDay() + 6) % 7
  const start = new Date(d)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - day + offset * 7)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  end.setMilliseconds(-1)
  return { start: start.getTime(), end: end.getTime() }
}

function monthBounds(offset = 0) {
  const d = new Date()
  const start = new Date(d.getFullYear(), d.getMonth() + offset, 1)
  const end = new Date(d.getFullYear(), d.getMonth() + offset + 1, 1)
  end.setMilliseconds(-1)
  return { start: start.getTime(), end: end.getTime() }
}

function yearBounds(offset = 0) {
  const d = new Date()
  const start = new Date(d.getFullYear() + offset, 0, 1)
  const end = new Date(d.getFullYear() + offset + 1, 0, 1)
  end.setMilliseconds(-1)
  return { start: start.getTime(), end: end.getTime() }
}

function periodBounds(period: AbwheelPeriod, offset = 0) {
  if (period === 'week') return weekBounds(offset)
  if (period === 'month') return monthBounds(offset)
  if (period === 'year') return yearBounds(offset)
  return null
}

function fillDaily(
  start: number,
  end: number,
  sparse: AbwheelTrendPoint[],
): AbwheelTrendPoint[] {
  const map = new Map<string, AbwheelTrendPoint>()
  for (const p of sparse) {
    const d = new Date(p.date)
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    map.set(key, p)
  }
  const out: AbwheelTrendPoint[] = []
  const cur = new Date(start)
  cur.setHours(0, 0, 0, 0)
  const endD = new Date(end)
  while (cur <= endD) {
    const key = `${cur.getFullYear()}-${cur.getMonth()}-${cur.getDate()}`
    const hit = map.get(key)
    out.push({
      date: cur.getTime(),
      count: hit?.count || 0,
      calories: hit?.calories || 0,
      durationSec: hit?.durationSec || 0,
    })
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

function fillMonths(year: number, sparse: AbwheelTrendPoint[]): AbwheelTrendPoint[] {
  const map = new Map<number, AbwheelTrendPoint>()
  for (const p of sparse) map.set(new Date(p.date).getMonth(), p)
  return Array.from({ length: 12 }, (_, month) => {
    const hit = map.get(month)
    return {
      date: new Date(year, month, 1).getTime(),
      count: hit?.count || 0,
      calories: hit?.calories || 0,
      durationSec: hit?.durationSec || 0,
    }
  })
}

export function AbWheelDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const showToast = useAppStore((s) => s.showToast)

  const [records, setRecords] = useState<AbwheelRecord[]>([])
  const [summary, setSummary] = useState<AbwheelSummary | null>(null)
  const [trends, setTrends] = useState<AbwheelTrends | null>(null)
  const [totals, setTotals] = useState<AbwheelTotals | null>(null)
  const [period, setPeriod] = useState<AbwheelPeriod>('week')
  const [offset, setOffset] = useState(0)
  const [periodLabel, setPeriodLabel] = useState('')
  const [periodPoints, setPeriodPoints] = useState<AbwheelTrendPoint[]>([])
  const [periodSummary, setPeriodSummary] = useState<{
    count?: number | null
    calories?: number | null
    durationSec?: number | null
  } | null>(null)
  const [metric, setMetric] = useState<TrendMetric>('count')
  const [loading, setLoading] = useState(false)
  const [periodLoading, setPeriodLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (quiet = false) => {
    if (dataSource !== 'live') {
      const mock = mockSeries()
      setRecords(mock)
      const totalCount = mock.reduce((a, r) => a + (r.count || 0), 0)
      const totalCal = mock.reduce((a, r) => a + (r.calories || 0), 0)
      const totalDur = mock.reduce((a, r) => a + (r.durationSec || 0), 0)
      setSummary({
        weekSessions: mock.length,
        weekCount: totalCount,
        weekCalories: totalCal,
        weekDurationSec: totalDur,
        monthSessions: mock.length,
        monthCount: totalCount,
        monthCalories: totalCal,
        monthDurationSec: totalDur,
        yearSessions: mock.length,
        yearCount: totalCount,
        yearCalories: totalCal,
        yearDurationSec: totalDur,
        totalSessions: mock.length,
        totalCount,
        totalCalories: totalCal,
        totalDurationSec: totalDur,
      })
      setTotals({
        count: totalCount,
        calories: totalCal,
        durationSec: totalDur,
        earliestTime: mock[mock.length - 1]?.startTime,
      })
      const dayPoints = mock
        .slice()
        .reverse()
        .map((r) => ({
          date: r.startTime,
          count: r.count || 0,
          calories: r.calories || 0,
          durationSec: r.durationSec || 0,
        }))
      const wb = weekBounds(0)
      const mb = monthBounds(0)
      const yb = yearBounds(0)
      setTrends({
        week: fillDaily(wb.start, wb.end, dayPoints),
        month: fillDaily(mb.start, mb.end, dayPoints),
        year: fillMonths(new Date(yb.start).getFullYear(), dayPoints),
      })
      setError(null)
      return
    }
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const data = await bridgeApi.getAbwheelHistory(device.id, {
        model: device.model,
        days: 366,
        limit: 100,
      })
      setRecords(Array.isArray(data.records) ? data.records : [])
      setSummary(data.summary ?? null)
      setTrends(data.trends ?? null)
      setTotals(data.totals ?? null)
    } catch (err) {
      const raw = err instanceof Error ? err.message : ''
      const msg =
        raw && raw !== '[object Object]' ? raw : '健腹轮训练数据加载失败'
      setError(msg)
      if (!quiet) showToast(msg)
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  const loadPeriod = async () => {
    if (period === 'all') {
      setPeriodPoints(trends?.year ?? [])
      setPeriodSummary({
        count: summary?.totalCount ?? totals?.count,
        calories: summary?.totalCalories ?? totals?.calories,
        durationSec: summary?.totalDurationSec ?? totals?.durationSec,
      })
      setPeriodLabel('全部')
      return
    }

    if (dataSource !== 'live') {
      const bounds = periodBounds(period, offset)
      if (!bounds) return
      const sparse =
        period === 'week'
          ? trends?.week ?? []
          : period === 'month'
            ? trends?.month ?? []
            : trends?.year ?? []
      const points =
        period === 'year'
          ? fillMonths(new Date(bounds.start).getFullYear(), sparse)
          : fillDaily(bounds.start, bounds.end, sparse)
      setPeriodPoints(points)
      setPeriodSummary({
        count: points.reduce((a, p) => a + p.count, 0),
        calories: points.reduce((a, p) => a + p.calories, 0),
        durationSec: points.reduce((a, p) => a + p.durationSec, 0),
      })
      const s = new Date(bounds.start)
      const e = new Date(bounds.end)
      setPeriodLabel(
        period === 'week'
          ? `${s.getMonth() + 1}/${s.getDate()} – ${e.getMonth() + 1}/${e.getDate()}`
          : period === 'month'
            ? `${s.getFullYear()}年${s.getMonth() + 1}月`
            : `${s.getFullYear()}年`,
      )
      return
    }

    setPeriodLoading(true)
    try {
      const data = await bridgeApi.getAbwheelPeriod(device.id, {
        period,
        offset,
        model: device.model,
      })
      setPeriodPoints(Array.isArray(data.points) ? data.points : [])
      setPeriodSummary(data.summary ?? null)
      setPeriodLabel(data.label || '')
    } catch (err) {
      // Fallback: fill from cached trends / records for current offset only
      const bounds = periodBounds(period, offset)
      if (bounds) {
        const fromRecords: AbwheelTrendPoint[] = records.map((r) => ({
          date: r.startTime,
          count: r.count || 0,
          calories: r.calories || 0,
          durationSec: r.durationSec || 0,
        }))
        setPeriodPoints(
          period === 'year'
            ? fillMonths(new Date(bounds.start).getFullYear(), fromRecords)
            : fillDaily(bounds.start, bounds.end, fromRecords),
        )
      }
      const raw = err instanceof Error ? err.message : ''
      if (raw) showToast(raw)
    } finally {
      setPeriodLoading(false)
    }
  }

  useEffect(() => {
    if (!hydrated) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, device.id, dataSource])

  useEffect(() => {
    setOffset(0)
  }, [period])

  useEffect(() => {
    if (!hydrated) return
    void loadPeriod()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, period, offset, trends, summary, totals, dataSource, device.id])

  const filteredRecords = useMemo(() => {
    const bounds = periodBounds(period, offset)
    if (!bounds) return records
    return records.filter(
      (r) => r.startTime >= bounds.start && r.startTime <= bounds.end,
    )
  }, [records, period, offset])

  const periodStats = useMemo(() => {
    if (period === 'all') {
      return {
        count: summary?.totalCount ?? totals?.count,
        calories: summary?.totalCalories ?? totals?.calories,
        durationSec: summary?.totalDurationSec ?? totals?.durationSec,
        sessions: summary?.totalSessions,
      }
    }
    return {
      count: periodSummary?.count,
      calories: periodSummary?.calories,
      durationSec: periodSummary?.durationSec,
      sessions: filteredRecords.length,
    }
  }, [period, periodSummary, summary, totals, filteredRecords.length])

  const latest = records[0] ?? null

  const metrics = useMemo(
    () => [
      {
        label: period === 'all' ? '累计次数' : '训练次数',
        value: periodStats.count != null ? fmtNum(periodStats.count, 0) : '—',
        unit: '次',
      },
      {
        label: period === 'all' ? '累计热量' : '消耗热量',
        value:
          periodStats.calories != null ? fmtNum(periodStats.calories, 1) : '—',
        unit: 'kcal',
      },
      {
        label: period === 'all' ? '累计时长' : '训练时长',
        value: fmtDuration(periodStats.durationSec),
        unit: '',
      },
      {
        label: '训练场次',
        value:
          periodStats.sessions != null
            ? fmtNum(periodStats.sessions, 0)
            : fmtNum(filteredRecords.length, 0),
        unit: '次',
      },
    ],
    [period, periodStats, filteredRecords.length],
  )

  return (
    <div className="abwheel-layout">
      <section className="abwheel-hero">
        <div className="abwheel-hero-copy">
          <span className="abwheel-badge">健腹轮</span>
          <p className="abwheel-tagline">
            训练记录来自米家 ym-sports 云。可按周 / 月 / 年切换时间并查看完整趋势。
          </p>
          {loading || periodLoading ? (
            <p className="abwheel-sync">正在同步…</p>
          ) : null}
          {error ? <p className="abwheel-error">{error}</p> : null}
        </div>
        <div className="abwheel-hero-stat">
          <span className="abwheel-stat-label">最近训练</span>
          <div className="abwheel-stat-value">
            <strong>
              {latest?.count != null ? fmtNum(latest.count, 0) : '—'}
            </strong>
            <span>次</span>
          </div>
          {latest ? (
            <span className="abwheel-stat-meta">
              {fmtTime(latest.startTime)}
              {latest.calories != null
                ? ` · ${fmtNum(latest.calories, 1)} kcal`
                : ''}
            </span>
          ) : (
            <span className="abwheel-stat-meta">暂无云端记录</span>
          )}
          <button
            type="button"
            className="btn btn-ghost abwheel-reload"
            disabled={loading}
            onClick={() => void load()}
          >
            刷新记录
          </button>
        </div>
      </section>

      <section className="abwheel-filter-bar">
        <div className="abwheel-period-tabs" role="tablist">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={period === p.id}
              className={period === p.id ? 'active' : undefined}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {totals?.count != null ? (
          <span className="meta soft">
            累计 {fmtNum(totals.count, 0)} 次
            {totals.calories != null
              ? ` · ${fmtNum(totals.calories, 1)} kcal`
              : ''}
          </span>
        ) : null}
      </section>

      <section className="abwheel-metrics">
        {metrics.map((m) => (
          <div key={m.label} className="abwheel-metric">
            <span className="label">{m.label}</span>
            <span className="value">
              {m.value}
              {m.unit ? <span className="unit">{m.unit}</span> : null}
            </span>
          </div>
        ))}
      </section>

      <section className="abwheel-chart-card">
        <AbWheelTrendChart
          points={periodPoints}
          period={period}
          metric={metric}
          onMetricChange={setMetric}
          label={periodLabel}
          offset={offset}
          onOffsetChange={setOffset}
          navDisabled={periodLoading}
        />
      </section>

      {period === 'all' && totals?.bestCount ? (
        <section className="abwheel-best">
          <div className="abwheel-best-item">
            <span className="label">单次最多</span>
            <strong>{fmtNum(totals.bestCount.count, 0)} 次</strong>
            <span className="meta soft">
              {fmtTime(totals.bestCount.startTime)}
            </span>
          </div>
          {totals.bestCalories ? (
            <div className="abwheel-best-item">
              <span className="label">单次最高热量</span>
              <strong>{fmtNum(totals.bestCalories.calories, 1)} kcal</strong>
              <span className="meta soft">
                {fmtTime(totals.bestCalories.startTime)}
              </span>
            </div>
          ) : null}
          {totals.bestDuration ? (
            <div className="abwheel-best-item">
              <span className="label">单次最长</span>
              <strong>{fmtDuration(totals.bestDuration.durationSec)}</strong>
              <span className="meta soft">
                {fmtTime(totals.bestDuration.startTime)}
              </span>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="abwheel-history">
        <div className="abwheel-history-head">
          <h3>训练历史</h3>
          <span className="meta soft">{filteredRecords.length} 条</span>
        </div>
        {!filteredRecords.length ? (
          <p className="abwheel-empty">
            当前时间段暂无训练数据。切换周期或完成一次训练并同步后再刷新。
          </p>
        ) : (
          <ul className="abwheel-history-list">
            {filteredRecords.map((r) => (
              <li key={r.id}>
                <div className="abwheel-hist-main">
                  <strong>{r.title || '健腹轮训练'}</strong>
                  <span>{fmtTime(r.startTime)}</span>
                </div>
                <div className="abwheel-hist-meta">
                  {r.count != null ? <span>{fmtNum(r.count, 0)} 次</span> : null}
                  {r.durationSec != null ? (
                    <span>{fmtDuration(r.durationSec)}</span>
                  ) : null}
                  {r.calories != null ? (
                    <span>{fmtNum(r.calories, 1)} kcal</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="abwheel-hint">
          机型 {device.model || 'xiaomi.abwheel.jfl001'} · ym-sports（HAW）·
          周/月显示全部日期（无数据为 0），年显示 12 个月。
        </p>
      </section>
    </div>
  )
}
