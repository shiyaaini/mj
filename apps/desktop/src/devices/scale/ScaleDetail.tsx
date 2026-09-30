import { useEffect, useMemo, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { bridgeApi, type ScaleRecord } from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { useAppStore } from '@/stores/appStore'
import { ScaleTrendChart, type TrendMetric } from './ScaleTrendChart'
import './scale.css'

interface Props {
  device: Device
}

function mockSeries(): ScaleRecord[] {
  const now = new Date()
  const samples: Array<{
    monthsAgo: number
    day: number
    w: number
    bmi: number
    fat: number
    mus: number
  }> = [
    { monthsAgo: 5, day: 8, w: 91.2, bmi: 29.8, fat: 28.1, mus: 59.8 },
    { monthsAgo: 4, day: 12, w: 90.1, bmi: 29.4, fat: 27.8, mus: 60.0 },
    { monthsAgo: 3, day: 3, w: 89.4, bmi: 29.2, fat: 27.5, mus: 60.2 },
    { monthsAgo: 3, day: 18, w: 88.9, bmi: 29.0, fat: 27.3, mus: 60.3 },
    { monthsAgo: 2, day: 5, w: 88.6, bmi: 28.9, fat: 27.1, mus: 60.4 },
    { monthsAgo: 2, day: 20, w: 88.0, bmi: 28.7, fat: 26.9, mus: 60.6 },
    { monthsAgo: 1, day: 4, w: 87.4, bmi: 28.5, fat: 26.7, mus: 60.8 },
    { monthsAgo: 1, day: 16, w: 86.8, bmi: 28.3, fat: 26.4, mus: 60.9 },
    { monthsAgo: 0, day: 2, w: 86.3, bmi: 28.2, fat: 26.2, mus: 60.5 },
    { monthsAgo: 0, day: 8, w: 87.9, bmi: 28.7, fat: 26.5, mus: 61.1 },
  ]
  return samples
    .map((s) => {
      const d = new Date(now.getFullYear(), now.getMonth() - s.monthsAgo, s.day, 8, 30)
      return {
        did: 'scale-1',
        model: 'yunmai.scales.ms107',
        createTime: d.getTime(),
        weight: s.w,
        bmi: s.bmi,
        bodyFat: s.fat,
        muscleMass: s.mus,
        bodyWater: 51.5 + (s.w % 3) * 0.2,
        boneMass: 3.4,
        visceralFat: 11,
        skeletalMuscle: 32 + (s.mus - 60) * 0.4,
        bodyScore: 80,
        metabolicAge: 20,
        bmr: 1740,
        heartRate: 0,
        idealWeight: 66.5,
        userName: '默认用户',
        height: 175,
      } satisfies ScaleRecord
    })
    .sort((a, b) => b.createTime - a.createTime)
}

function fmtNum(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return Number(v).toFixed(digits)
}

function fmtTime(ms: number, locale: string) {
  if (!ms) return '—'
  try {
    return new Intl.DateTimeFormat(locale, {
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

function recordYear(ms: number) {
  return new Date(ms).getFullYear()
}

function recordMonth(ms: number) {
  return new Date(ms).getMonth() + 1
}

export function ScaleDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const showToast = useAppStore((s) => s.showToast)

  const [records, setRecords] = useState<ScaleRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('weight')
  const [filterYear, setFilterYear] = useState<string>('')
  const [filterMonth, setFilterMonth] = useState<string>('')

  const load = async (quiet = false) => {
    if (dataSource !== 'live') {
      setRecords(mockSeries())
      setError(null)
      return
    }
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const data = await bridgeApi.getScaleHistory(device.id, {
        model: device.model,
        limit: 100,
      })
      setRecords(Array.isArray(data.records) ? data.records : [])
    } catch (err) {
      const raw = err instanceof Error ? err.message : ''
      const msg =
        raw && raw !== '[object Object]' ? raw : "体脂数据加载失败"
      setError(msg)
      if (!quiet) showToast(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!hydrated) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on device/source change
  }, [hydrated, dataSource, device.id, device.model])

  const years = useMemo(() => {
    const set = new Set<number>()
    for (const r of records) {
      if (r.createTime) set.add(recordYear(r.createTime))
    }
    return [...set].sort((a, b) => b - a)
  }, [records])

  const months = useMemo(() => {
    if (!filterYear) return []
    const y = Number(filterYear)
    const set = new Set<number>()
    for (const r of records) {
      if (!r.createTime || recordYear(r.createTime) !== y) continue
      set.add(recordMonth(r.createTime))
    }
    return [...set].sort((a, b) => a - b)
  }, [records, filterYear])

  useEffect(() => {
    if (filterMonth && !months.includes(Number(filterMonth))) {
      setFilterMonth('')
    }
  }, [months, filterMonth])

  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (!r.createTime) return false
      if (filterYear && recordYear(r.createTime) !== Number(filterYear)) return false
      if (filterMonth && recordMonth(r.createTime) !== Number(filterMonth)) return false
      return true
    })
  }, [records, filterYear, filterMonth])

  const latest = records[0] || null

  const metrics = useMemo(() => {
    if (!latest) return []
    return [
      { key: 'bmi', label: "BMI", value: fmtNum(latest.bmi), unit: '' },
      { key: 'bodyFat', label: "体脂率", value: fmtNum(latest.bodyFat), unit: '%' },
      {
        key: 'muscle',
        label: "肌肉量",
        value: fmtNum(latest.muscleMass),
        unit: 'kg',
      },
      {
        key: 'water',
        label: "体水分",
        value: fmtNum(latest.bodyWater),
        unit: '%',
      },
      { key: 'bone', label: "骨量", value: fmtNum(latest.boneMass), unit: 'kg' },
      {
        key: 'visceral',
        label: "内脏脂肪",
        value: fmtNum(latest.visceralFat, 0),
        unit: '',
      },
      {
        key: 'score',
        label: "身体得分",
        value: fmtNum(latest.bodyScore, 0),
        unit: '',
      },
      {
        key: 'age',
        label: "代谢年龄",
        value: fmtNum(latest.metabolicAge, 0),
        unit: "岁",
      },
      {
        key: 'bmr',
        label: "基础代谢",
        value: fmtNum(latest.bmr, 0),
        unit: 'kcal',
      },
      {
        key: 'smm',
        label: "骨骼肌",
        value: fmtNum(latest.skeletalMuscle),
        unit: 'kg',
      },
    ]
  }, [latest])

  const weightDelta = useMemo(() => {
    if (records.length < 2) return null
    const delta = Number(records[0].weight) - Number(records[1].weight)
    if (!Number.isFinite(delta)) return null
    return delta
  }, [records])

  const filterBar = (
    <div className="scale-filters">
      <label className="scale-filter-field">
        <span>年份</span>
        <select
          value={filterYear}
          onChange={(e) => {
            setFilterYear(e.target.value)
            setFilterMonth('')
          }}
        >
          <option value="">全部年份</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <label className="scale-filter-field">
        <span>月份</span>
        <select
          value={filterMonth}
          disabled={!filterYear}
          onChange={(e) => setFilterMonth(e.target.value)}
        >
          <option value="">全部月份</option>
          {months.map((m) => (
            <option key={m} value={String(m)}>
              {`${m}月`}
            </option>
          ))}
        </select>
      </label>
      <span className="scale-filter-count meta soft">
        {`${filtered.length} 条记录`}
      </span>
    </div>
  )

  return (
    <div className="scale-layout">
      <section className="scale-hero">
        <div className="scale-hero-copy">
          <p className="scale-tagline">体重与身体成分记录，来自米家健康云同步</p>
          {loading ? <p className="scale-sync">正在同步…</p> : null}
          {error ? <p className="scale-error">{error}</p> : null}
        </div>
        <div className="scale-hero-weight">
          <span className="scale-weight-label">最近体重</span>
          <div className="scale-weight-value">
            <strong>{latest ? fmtNum(latest.weight) : '—'}</strong>
            <small>kg</small>
          </div>
          {weightDelta != null ? (
            <span className={`scale-delta${weightDelta > 0 ? ' up' : weightDelta < 0 ? ' down' : ''}`}>
              {weightDelta > 0 ? '+' : ''}
              {fmtNum(weightDelta)} kg
            </span>
          ) : (
            <span className="scale-delta muted">较上次</span>
          )}
          {latest?.userName ? (
            <span className="scale-user">
              {latest.userName}
              {latest.height ? ` · ${fmtNum(latest.height, 0)} cm` : ''}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost scale-reload"
            disabled={loading}
            onClick={() => void load()}
          >
            刷新
          </button>
        </div>
      </section>

      <section className="scale-metrics">
        <h3>身体成分</h3>
        {!latest && !loading ? (
          <p className="scale-empty">暂无测量数据</p>
        ) : (
          <div className="scale-metric-grid">
            {metrics.map((m) => (
              <div key={m.key} className="scale-metric">
                <span>{m.label}</span>
                <strong>
                  {m.value}
                  {m.unit && m.value !== '—' ? <small>{m.unit}</small> : null}
                </strong>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="scale-chart-card">
        {filterBar}
        <ScaleTrendChart
          records={filtered}
          metric={trendMetric}
          onMetricChange={setTrendMetric}
          locale="zh-CN"
        />
      </section>

      <section className="scale-history">
        <div className="scale-history-head">
          <h3>历史记录</h3>
          <span className="meta soft">{`${filtered.length} 条记录`}</span>
        </div>
        {filtered.length === 0 && !loading ? (
          <p className="scale-empty">
            {records.length ? "当前年月没有记录" : "还没有称重记录"}
          </p>
        ) : (
          <ul className="scale-history-list">
            {filtered.map((r) => (
              <li key={`${r.createTime}-${r.weight}`}>
                <div className="scale-hist-main">
                  <strong>{fmtNum(r.weight)} kg</strong>
                  <span>{fmtTime(r.createTime, 'zh-CN')}</span>
                </div>
                <div className="scale-hist-meta">
                  <span>
                    BMI {fmtNum(r.bmi)} · 体脂率 {fmtNum(r.bodyFat)}%
                  </span>
                  <span>
                    肌肉量 {fmtNum(r.muscleMass)} kg
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="scale-hint">数据来自米家健康云历史记录。实时称重仍需靠近设备，经蓝牙同步到云端后可在此查看。</p>
      </section>
    </div>
  )
}
