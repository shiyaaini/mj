import { useEffect, useMemo, useRef, useState } from 'react'
import type { Device } from '@mi-home/shared'
import { bridgeApi, type DeviceCapabilities, type SpeakerNowPlaying } from '@/api/bridge'
import { useAppStoreHydrated } from '@/hooks/useAppStoreHydrated'
import { useAppStore } from '@/stores/appStore'
import { DeviceCapabilityPanel } from '@/devices/shared/DeviceCapabilityPanel'
import '@/devices/shared/detail.css'
import './speaker.css'

/** Spec: `HH:MM:SS-HH:MM:SS` → UI time inputs use `HH:MM` */
function parsePeriod(raw: string): { start: string; end: string } {
  const m = raw.trim().match(/^(\d{2}:\d{2})(?::\d{2})?-(\d{2}:\d{2})(?::\d{2})?$/)
  if (!m) return { start: '21:50', end: '06:50' }
  return { start: m[1], end: m[2] }
}

function formatPeriod(start: string, end: string): string {
  const toSpec = (t: string) => {
    const parts = t.split(':')
    const hh = (parts[0] || '00').padStart(2, '0')
    const mm = (parts[1] || '00').padStart(2, '0')
    return `${hh}:${mm}:00`
  }
  return `${toSpec(start)}-${toSpec(end)}`
}

/** Props/actions covered by this page — hidden from Spec supplement */
const SPEAKER_TEMPLATE_PROPS = [
  'volume',
  'mute-2',
  'mute-4',
  'playing-state',
  'sleep-mode',
  'audio-id',
  'no-disturb',
  'enable-time-period',
  'text-content',
  'silent-execution',
  'play',
  'pause',
  'previous',
  'next',
  'stop-alarm',
  'wake-up',
  'play-radio',
  'play-text',
  'execute-text-directive',
  'play-music',
  'tv-switchon',
]

/** Media-related props polled while this page is open */
const MEDIA_POLL_PROPS = [
  'playing-state',
  'audio-id',
  'volume',
  'sleep-mode',
  'mute-2',
  'mute-4',
  'no-disturb',
]

const POLL_MS = 4000
/** After local play/pause, ignore cloud playing-state for a bit (device lags) */
const MEDIA_HOLD_MS = 3500

interface Props {
  device: Device
}

function playingLabel(state: number): string {
  if (state === 1) return '播放中'
  if (state === 2) return '已暂停'
  return '已停止'
}

/** Spec 通常只给 audio-id，不给歌名；尽量从 JSON / 可读字符串里解析展示文案 */
function describeAudio(raw: string): { title: string; subtitle: string } {
  const s = raw.trim()
  if (!s) {
    return {
      title: '暂无曲目信息',
      subtitle: '等待云端同步…',
    }
  }
  try {
    const j = JSON.parse(s) as Record<string, unknown>
    if (j && typeof j === 'object') {
      const title = j.title ?? j.name ?? j.song ?? j.audioName ?? j.track
      const artist = j.artist ?? j.singer ?? j.author ?? j.album
      if (title != null && String(title).trim()) {
        return {
          title: String(title),
          subtitle: artist != null && String(artist).trim() ? String(artist) : '来自设备上报',
        }
      }
    }
  } catch {
    /* not JSON */
  }
  try {
    const decoded = decodeURIComponent(s)
    if (decoded !== s && /[\u4e00-\u9fffA-Za-z]/.test(decoded) && decoded.length < 160) {
      return { title: decoded, subtitle: '音频标识' }
    }
  } catch {
    /* ignore */
  }
  const short = s.length > 42 ? `${s.slice(0, 40)}…` : s
  return {
    title: short,
    subtitle: '音频 ID',
  }
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Only real true/1 — avoids Boolean("0") / Boolean("false") traps */
function asStrictBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

export function SpeakerDetail({ device }: Props) {
  const hydrated = useAppStoreHydrated()
  const dataSource = useAppStore((s) => s.dataSource)
  const cachedEntry = useAppStore((s) => s.capabilityCache[device.id])
  const rememberCapabilities = useAppStore((s) => s.rememberCapabilities)
  const refreshDeviceCapabilities = useAppStore((s) => s.refreshDeviceCapabilities)
  const showToast = useAppStore((s) => s.showToast)

  const [caps, setCaps] = useState<DeviceCapabilities | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [volumeUi, setVolumeUi] = useState(50)
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [directive, setDirective] = useState('')
  const [silentExec, setSilentExec] = useState(false)
  const [dndStart, setDndStart] = useState('21:50')
  const [dndEnd, setDndEnd] = useState('06:50')
  const [mediaSyncing, setMediaSyncing] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<SpeakerNowPlaying | null>(null)
  const [coverFailed, setCoverFailed] = useState(false)
  const mediaHoldUntilRef = useRef(0)
  const valuesRef = useRef(values)
  valuesRef.current = values

  useEffect(() => {
    setCoverFailed(false)
  }, [nowPlaying?.coverUrl])

  const holdMediaState = (ms = MEDIA_HOLD_MS) => {
    mediaHoldUntilRef.current = Date.now() + ms
  }

  const isMediaHeld = () => Date.now() < mediaHoldUntilRef.current

  const applyMediaProps = (props: Record<string, unknown>, opts?: { respectHold?: boolean }) => {
    if (!props || !Object.keys(props).length) return
    const respectHold = opts?.respectHold !== false
    let nextProps = props
    if (respectHold && isMediaHeld() && 'playing-state' in props) {
      const { 'playing-state': _ignored, ...rest } = props
      nextProps = rest
      if (!Object.keys(nextProps).length) return
    }
    setValues((prev) => {
      const next = { ...prev, ...nextProps }
      const base = caps || useAppStore.getState().capabilityCache[device.id]?.caps
      if (base) rememberCapabilities(device.id, { ...base, values: next })
      return next
    })
  }

  const refreshNowPlaying = async (opts?: { respectHold?: boolean }) => {
    if (dataSource !== 'live') return
    try {
      const np = await bridgeApi.getSpeakerNowPlaying(device.id)
      const respectHold = opts?.respectHold !== false
      if (respectHold && isMediaHeld() && np.status != null) {
        // Keep metadata/cover; do not let stale status flip the transport UI
        setNowPlaying({
          ...np,
          status: Number(valuesRef.current['playing-state'] ?? np.status),
          playing: Number(valuesRef.current['playing-state'] ?? np.status) === 1,
          paused: Number(valuesRef.current['playing-state'] ?? np.status) === 2,
        })
        applyMediaProps(
          {
            ...(np.audioId ? { 'audio-id': np.audioId } : {}),
            ...(typeof np.volume === 'number' ? { volume: np.volume } : {}),
          },
          { respectHold: true },
        )
        return
      }
      setNowPlaying(np)
      if (np.available && np.status != null) {
        applyMediaProps(
          {
            'playing-state': np.status,
            ...(np.audioId ? { 'audio-id': np.audioId } : {}),
            ...(typeof np.volume === 'number' ? { volume: np.volume } : {}),
          },
          { respectHold },
        )
      }
    } catch {
      /* Spec poll still works; keep last nowPlaying */
    }
  }

  const refreshMedia = async (quiet = true, opts?: { respectHold?: boolean }) => {
    if (dataSource !== 'live') return
    if (!quiet) setMediaSyncing(true)
    const respectHold = opts?.respectHold !== false
    try {
      // Spec first, then MiNA — music path status/volume from MiNA must win
      const { props } = await bridgeApi.getProps(device.id, MEDIA_POLL_PROPS)
      applyMediaProps(props || {}, { respectHold })
      await refreshNowPlaying({ respectHold })
    } catch {
      if (!quiet) showToast('播放状态同步失败')
    } finally {
      if (!quiet) setMediaSyncing(false)
    }
  }

  useEffect(() => {
    if (!hydrated) return
    if (!cachedEntry?.caps) return
    setCaps(cachedEntry.caps)
    setValues(cachedEntry.caps.values || {})
  }, [hydrated, cachedEntry])

  useEffect(() => {
    if (!hydrated) return
    if (dataSource !== 'live') {
      const mock = {
        volume: Number(device.preview?.volume ?? 52),
        'mute-2': false,
        'mute-4': false,
        'playing-state': device.preview?.playing ? 1 : 0,
        'sleep-mode': false,
        'audio-id': device.preview?.playing ? 'demo-track-qing-tian' : '',
        'no-disturb': false,
        'enable-time-period': '21:50:00-06:50:00',
      }
      setValues(mock)
      setVolumeUi(Number(mock.volume))
      const period = parsePeriod(String(mock['enable-time-period']))
      setDndStart(period.start)
      setDndEnd(period.end)
      return
    }
    let cancelled = false
    const load = async () => {
      const hadCache = Boolean(useAppStore.getState().capabilityCache[device.id])
      if (hadCache) setSyncing(true)
      try {
        await refreshDeviceCapabilities(device.id)
        if (!cancelled) await refreshMedia(true)
      } finally {
        if (!cancelled) setSyncing(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll helpers use latest store
  }, [hydrated, dataSource, device.id, refreshDeviceCapabilities])

  /** Live poll: playing-state / audio-id 等，页面打开时持续刷新 */
  useEffect(() => {
    if (!hydrated || dataSource !== 'live') return
    const id = window.setInterval(() => {
      void refreshMedia(true)
    }, POLL_MS)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, dataSource, device.id])

  useEffect(() => {
    const v = Number(values.volume)
    if (Number.isFinite(v)) setVolumeUi(v)
  }, [values.volume])

  useEffect(() => {
    const p = values['enable-time-period']
    if (typeof p === 'string' && p.trim()) {
      const period = parsePeriod(p)
      setDndStart(period.start)
      setDndEnd(period.end)
    }
  }, [values['enable-time-period']])

  const playingState = (() => {
    // QQ 音乐等走小爱云端时，Spec playing-state 常滞后；有 MiNA 且未在本地操作保护窗内时以云端为准
    if (
      !isMediaHeld() &&
      nowPlaying?.available &&
      nowPlaying.status != null &&
      Number.isFinite(Number(nowPlaying.status))
    ) {
      return Number(nowPlaying.status)
    }
    return Number(values['playing-state'] ?? 0)
  })()
  const isPlaying = playingState === 1
  const sleepMode = asStrictBool(values['sleep-mode'])
  /** Spec mute-2 对 QQ 音乐路径经常不准；有 MiNA 音量时以音量是否为 0 判断是否静音 */
  const specMuted = asStrictBool(values['mute-2'])
  const muted =
    nowPlaying?.available && typeof nowPlaying.volume === 'number'
      ? Number(nowPlaying.volume) <= 0
      : specMuted
  const micMuted = asStrictBool(values['mute-4'])
  const noDisturb = asStrictBool(values['no-disturb'])
  const audioId = String(values['audio-id'] || nowPlaying?.audioId || '')
  const audioDesc = useMemo(() => {
    if (nowPlaying?.title) {
      const parts = [nowPlaying.artist, nowPlaying.album, nowPlaying.cpName].filter(
        (x): x is string => Boolean(x && String(x).trim()),
      )
      return {
        title: nowPlaying.title,
        subtitle: parts.length ? parts.join(' · ') : '来自小爱云端',
      }
    }
    return describeAudio(audioId)
  }, [nowPlaying, audioId])
  const progressLabel = useMemo(() => {
    const pos = formatMs(nowPlaying?.positionMs)
    const dur = formatMs(nowPlaying?.durationMs)
    if (!pos && !dur) return ''
    return `${pos || '0:00'} / ${dur || '--:--'}`
  }, [nowPlaying?.positionMs, nowPlaying?.durationMs])
  const hasPlayingState =
    Object.prototype.hasOwnProperty.call(values, 'playing-state') ||
    nowPlaying?.status != null

  const volumeRange = useMemo(() => {
    const prop = caps?.properties?.find((p) => p.name === 'volume')
    const r = prop?.range
    if (Array.isArray(r) && r.length >= 2) {
      return {
        min: Number(r[0]) || 5,
        max: Number(r[1]) || 100,
        step: Number(r[2]) || 1,
      }
    }
    return { min: 5, max: 100, step: 1 }
  }, [caps])

  const setPropValue = async (name: string, value: unknown) => {
    const prev = values[name]
    const nextValues = { ...values, [name]: value }
    setValues(nextValues)
    if (caps) rememberCapabilities(device.id, { ...caps, values: nextValues })
    if (dataSource !== 'live') return
    setBusy(name)
    try {
      await bridgeApi.setProp(device.id, name, value)
      if (name === 'mute-2' || name === 'volume') {
        window.setTimeout(() => {
          void refreshNowPlaying({ respectHold: true })
        }, 500)
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

  const runAction = async (name: string, params: unknown[] = []) => {
    // Optimistic transport UI immediately — cloud status lags and was flipping the button back
    if (name === 'play' || name === 'play-music' || name === 'play-radio') {
      holdMediaState()
      setValues((v) => ({ ...v, 'playing-state': 1, 'sleep-mode': false }))
      setNowPlaying((np) =>
        np
          ? { ...np, status: 1, playing: true, paused: false, state: 'playing' }
          : np,
      )
    } else if (name === 'pause') {
      holdMediaState()
      setValues((v) => ({ ...v, 'playing-state': 2 }))
      setNowPlaying((np) =>
        np
          ? { ...np, status: 2, playing: false, paused: true, state: 'paused' }
          : np,
      )
    } else if (name === 'wake-up') {
      setValues((v) => ({ ...v, 'sleep-mode': false }))
    }

    setBusy(name)
    try {
      if (dataSource === 'live') {
        await bridgeApi.runDeviceAction(device.id, name, params)
      }
      if (dataSource === 'live') {
        // Sync metadata after device settles; hold keeps playing-state stable
        window.setTimeout(() => {
          void refreshMedia(true, { respectHold: true })
        }, 1200)
        window.setTimeout(() => {
          void refreshMedia(true, { respectHold: false })
        }, MEDIA_HOLD_MS + 400)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '同步失败')
      // Allow cloud truth to correct optimistic state
      mediaHoldUntilRef.current = 0
      if (dataSource === 'live') void refreshMedia(true, { respectHold: false })
    } finally {
      setBusy(null)
    }
  }

  const commitVolume = async (next: number) => {
    const clamped = Math.min(volumeRange.max, Math.max(volumeRange.min, next))
    setVolumeUi(clamped)
    await setPropValue('volume', clamped)
  }

  const toggleSleep = async () => {
    if (sleepMode) {
      await runAction('wake-up')
      await setPropValue('sleep-mode', false)
    } else {
      await setPropValue('sleep-mode', true)
    }
  }

  const runDirective = async () => {
    const text = directive.trim()
    if (!text) {
      showToast("请先输入指令文本")
      return
    }
    await runAction('execute-text-directive', [text, silentExec])
  }

  const speakText = async () => {
    const text = directive.trim()
    if (!text) {
      showToast("请先输入指令文本")
      return
    }
    await runAction('play-text', [text])
  }

  const saveDndPeriod = async () => {
    if (!/^\d{2}:\d{2}$/.test(dndStart) || !/^\d{2}:\d{2}$/.test(dndEnd)) {
      showToast("请选择有效的开始和结束时间")
      return
    }
    await setPropValue('enable-time-period', formatPeriod(dndStart, dndEnd))
  }

  const volPct = ((volumeUi - volumeRange.min) / (volumeRange.max - volumeRange.min || 1)) * 100

  return (
    <div className="detail-layout speaker-layout">
      <section className="panel hero-panel template-hero speaker-hero">
        <div className="speaker-hero-top">
          <div className="speaker-icon" aria-hidden>
            ♪
          </div>
          <div className="speaker-status-row">
            <span className={`speaker-chip${isPlaying ? ' playing' : ''}`}>
              {playingLabel(playingState)}
            </span>
            <span className={`speaker-chip${sleepMode ? ' sleep' : ' awake'}`}>
              {sleepMode ? "休眠" : "已唤醒"}
            </span>
            {muted ? <span className="speaker-chip muted">已静音</span> : null}
          </div>
        </div>
        {syncing ? <p className="meta soft">正在同步…</p> : null}
      </section>

      <section className="panel plug-card-panel speaker-now-playing">
        <div className="plug-card-head row">
          <strong>当前播放</strong>
          <button
            type="button"
            className="btn btn-ghost speaker-refresh-media"
            disabled={mediaSyncing || dataSource !== 'live'}
            onClick={() => void refreshMedia(false)}
          >
            {mediaSyncing ? '同步中…' : '刷新状态'}
          </button>
        </div>
        <div className={`speaker-now-card${isPlaying ? ' playing' : ''}${sleepMode ? ' sleep' : ''}`}>
          {nowPlaying?.coverUrl && !coverFailed ? (
            <img
              className="speaker-now-cover"
              src={nowPlaying.coverUrl}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setCoverFailed(true)}
            />
          ) : (
            <div className="speaker-now-icon" aria-hidden>
              {sleepMode ? '☾' : isPlaying ? '♪' : playingState === 2 ? '⏸' : '⏹'}
            </div>
          )}
          <div className="speaker-now-copy">
            <p className="speaker-now-state">
              {sleepMode
                ? '设备休眠中'
                : hasPlayingState
                  ? playingLabel(playingState)
                  : '播放状态未知'}
            </p>
            <p className="speaker-now-title">{audioDesc.title}</p>
            <p className="meta soft">{audioDesc.subtitle}</p>
            {progressLabel ? <p className="speaker-now-progress">{progressLabel}</p> : null}
            {audioId && !nowPlaying?.title ? (
              <p className="speaker-audio-id" title={audioId}>
                ID: {audioId}
              </p>
            ) : null}
          </div>
        </div>
        {sleepMode ? (
          <p className="meta soft speaker-now-hint">
            休眠时通常无法读取播放内容。可先点「唤醒」，再播音乐后刷新状态。
          </p>
        ) : nowPlaying?.available === false ? (
          <p className="meta soft speaker-now-hint">
            未在小爱云端找到该设备，暂无法获取歌名；仍可同步 Spec 播放状态。
          </p>
        ) : (
          <p className="meta soft speaker-now-hint">
            歌名/歌手来自小爱云端（MiNA）；页面每 {POLL_MS / 1000} 秒自动同步。
          </p>
        )}
      </section>

      <section className="panel plug-card-panel">
        <div className="speaker-transport">
          <button
            type="button"
            className="speaker-ctl"
            disabled={!!busy}
            onClick={() => void runAction('previous')}
            title="上一首"
          >
            ⏮
          </button>
          <button
            type="button"
            className="speaker-ctl main"
            disabled={!!busy}
            onClick={() => void runAction(isPlaying ? 'pause' : 'play')}
            title={isPlaying ? "暂停" : "播放"}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className="speaker-ctl"
            disabled={!!busy}
            onClick={() => void runAction('next')}
            title="下一首"
          >
            ⏭
          </button>
        </div>
        <div className="speaker-action-row">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => void runAction('play-music')}
          >
            播放音乐
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => void runAction('play-radio')}
          >
            播放电台
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => void runAction('stop-alarm')}
          >
            停止闹钟
          </button>
        </div>
      </section>

      <section className="panel plug-card-panel">
        <div className="plug-card-head row">
          <strong>音量</strong>
          <span className="speaker-vol-value">{volumeUi}%</span>
        </div>
        <div className="speaker-volume-row">
          <button
            type="button"
            className={`speaker-mute-btn${muted ? ' on' : ''}`}
            disabled={busy === 'mute-2'}
            onClick={() => void setPropValue('mute-2', !specMuted)}
            title={muted ? '取消静音' : '静音'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <input
            className="speaker-slider"
            type="range"
            min={volumeRange.min}
            max={volumeRange.max}
            step={volumeRange.step}
            value={volumeUi}
            disabled={busy === 'volume' || muted}
            style={{
              background: `linear-gradient(90deg, var(--accent) ${volPct}%, var(--switch-track) ${volPct}%)`,
            }}
            onChange={(e) => setVolumeUi(Number(e.target.value))}
            onMouseUp={(e) => void commitVolume(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) =>
              void commitVolume(Number((e.target as HTMLInputElement).value))
            }
          />
        </div>
      </section>

      <section className="panel plug-card-panel">
        <h2>模式</h2>
        <div className="speaker-toggles">
          <div className="speaker-toggle-row">
            <div>
              <strong>睡眠模式</strong>
              <p className="meta soft">开启后进入休眠；关闭时会尝试唤醒</p>
            </div>
            <button
              type="button"
              className={`switch${sleepMode ? ' on' : ''}`}
              disabled={busy === 'sleep-mode' || busy === 'wake-up'}
              onClick={() => void toggleSleep()}
            />
          </div>
          <div className="speaker-toggle-row">
            <div>
              <strong>勿扰模式</strong>
              <p className="meta soft">勿扰时段内减少主动播报</p>
            </div>
            <button
              type="button"
              className={`switch${noDisturb ? ' on' : ''}`}
              disabled={busy === 'no-disturb'}
              onClick={() => void setPropValue('no-disturb', !noDisturb)}
            />
          </div>
          <div className="speaker-toggle-row">
            <div>
              <strong>麦克风静音</strong>
              <p className="meta soft">仅关闭麦克风拾音，不影响扬声器出声</p>
            </div>
            <button
              type="button"
              className={`switch${micMuted ? ' on' : ''}`}
              disabled={busy === 'mute-4'}
              onClick={() => void setPropValue('mute-4', !micMuted)}
            />
          </div>
        </div>

        <div className="speaker-period">
          <span className="speaker-period-label">勿扰时间段</span>
          <div className="speaker-period-fields">
            <label>
              <span>开始</span>
              <input
                type="time"
                value={dndStart}
                onChange={(e) => setDndStart(e.target.value || '21:50')}
                disabled={busy === 'enable-time-period'}
              />
            </label>
            <span className="speaker-period-sep" aria-hidden>
              –
            </span>
            <label>
              <span>结束</span>
              <input
                type="time"
                value={dndEnd}
                onChange={(e) => setDndEnd(e.target.value || '06:50')}
                disabled={busy === 'enable-time-period'}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === 'enable-time-period'}
              onClick={() => void saveDndPeriod()}
            >
              保存
            </button>
          </div>
        </div>
      </section>

      <section className="panel plug-card-panel">
        <h2>语音 / 文本指令</h2>
        <p className="meta soft">调用 execute-text-directive / play-text，需设备在线</p>
        <textarea
          className="speaker-directive-input"
          rows={3}
          value={directive}
          onChange={(e) => setDirective(e.target.value)}
          placeholder="例如：今天天气怎么样"
        />
        <label className="speaker-silent">
          <input
            type="checkbox"
            checked={silentExec}
            onChange={(e) => setSilentExec(e.target.checked)}
          />
          <span>静默执行（不播报）</span>
        </label>
        <div className="speaker-action-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy}
            onClick={() => void runDirective()}
          >
            执行指令
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => void speakText()}
          >
            朗读文本
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => void runAction('wake-up')}
          >
            唤醒
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => void runAction('tv-switchon')}
          >
            打开电视
          </button>
        </div>
      </section>

      <DeviceCapabilityPanel
        device={device}
        asSupplement
        excludeNames={SPEAKER_TEMPLATE_PROPS}
      />
    </div>
  )
}
