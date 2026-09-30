// 灯插件包示例 — 与 config.json 一起打成 zip 后安装
// 结构：
//   config.json
//   index.jsx
//   assets/logo.svg

import { useEffect, useState } from 'react'

function readCt(values) {
  const v = values['color-temperature'] ?? values.color_temperature
  return Number(v ?? 4000)
}

function readBright(values) {
  const raw = Number(values.brightness ?? 60)
  if (raw > 100) return Math.max(1, Math.round((raw / 65535) * 100))
  return Math.max(1, Math.min(100, raw || 60))
}

export default function LightPlugin({ miPlugin, device, values, config }) {
  const on = Boolean(values.on)
  const [brightness, setBrightness] = useState(() => readBright(values))
  const [ct, setCt] = useState(() => readCt(values))
  const [busy, setBusy] = useState(null)
  const logo = config?.logo ? miPlugin.assetUrl(config.logo) : ''

  useEffect(() => {
    setBrightness(readBright(values))
    setCt(readCt(values))
  }, [values.on, values.brightness, values['color-temperature'], values.color_temperature])

  const toggle = async () => {
    setBusy('power')
    try {
      await miPlugin.setSwitch(!on)
      miPlugin.toast(!on ? '灯已打开' : '灯已关闭')
    } finally {
      setBusy(null)
    }
  }

  const commitBrightness = async (ui) => {
    setBusy('brightness')
    try {
      await miPlugin.setProp('brightness', ui)
      miPlugin.toast(`亮度 ${ui}%`)
    } finally {
      setBusy(null)
    }
  }

  const commitCt = async (kelvin) => {
    setBusy('ct')
    try {
      try {
        await miPlugin.setProp('color-temperature', kelvin)
      } catch {
        await miPlugin.setProp('color_temperature', kelvin)
      }
      miPlugin.toast(`色温 ${kelvin}K`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="light-plugin">
      <style>{`
        .light-plugin {
          display: grid;
          gap: 16px;
          padding: 4px 2px 8px;
          color: #1e293b;
        }
        .light-plugin .hero {
          display: grid;
          place-items: center;
          gap: 12px;
          min-height: 150px;
          border-radius: 16px;
          background: linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%);
        }
        .light-plugin .brand {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .light-plugin .brand img {
          width: 36px;
          height: 36px;
          object-fit: contain;
        }
        .light-plugin .bulb {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          border: 0;
          cursor: pointer;
          background: var(--bulb-bg);
          box-shadow: var(--bulb-shadow);
        }
        .light-plugin .bulb:disabled { opacity: 0.6; }
        .light-plugin .meta { margin: 0; font-size: 13px; color: #64748b; }
        .light-plugin .panel {
          display: grid;
          gap: 14px;
          padding: 14px 16px;
          border-radius: 14px;
          background: #fff;
          border: 1px solid #e2e8f0;
        }
        .light-plugin .head {
          display: flex;
          justify-content: space-between;
          font-size: 13px;
          color: #64748b;
        }
        .light-plugin .head b { color: #0f172a; }
        .light-plugin input[type="range"] { width: 100%; accent-color: #3b82f6; }
        .light-plugin .actions button {
          padding: 8px 12px;
          border: 0;
          border-radius: 10px;
          background: #e2e8f0;
          cursor: pointer;
        }
      `}</style>

      <section
        className="hero"
        style={{
          ['--bulb-bg']: on
            ? `hsl(42, 100%, ${55 + brightness / 5}%)`
            : '#cbd5e1',
          ['--bulb-shadow']: on
            ? `0 0 ${18 + brightness / 4}px rgba(251, 191, 36, 0.55)`
            : '0 2px 8px rgba(15, 23, 42, 0.08)',
        }}
      >
        <div className="brand">
          {logo ? <img src={logo} alt="" /> : null}
          <strong>{config?.name || device.name}</strong>
        </div>
        <button
          type="button"
          className="bulb"
          disabled={busy === 'power'}
          aria-label={on ? '关闭' : '打开'}
          onClick={() => void toggle()}
        />
        <p className="meta">
          {device.name} · {device.status === 'online' ? '在线' : '离线'} ·{' '}
          {on ? '已开启' : '已关闭'}
        </p>
      </section>

      <section className="panel">
        <div>
          <div className="head">
            <span>亮度</span>
            <b>{brightness}%</b>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={brightness}
            disabled={!on || busy === 'brightness'}
            onChange={(e) => setBrightness(Number(e.target.value))}
            onMouseUp={(e) => void commitBrightness(Number(e.target.value))}
            onTouchEnd={(e) => void commitBrightness(Number(e.target.value))}
          />
        </div>
        <div>
          <div className="head">
            <span>色温</span>
            <b>{ct}K</b>
          </div>
          <input
            type="range"
            min={2700}
            max={6500}
            step={50}
            value={ct}
            disabled={!on || busy === 'ct'}
            onChange={(e) => setCt(Number(e.target.value))}
            onMouseUp={(e) => void commitCt(Number(e.target.value))}
            onTouchEnd={(e) => void commitCt(Number(e.target.value))}
          />
        </div>
        <div className="actions">
          <button type="button" onClick={() => void miPlugin.reload()}>
            刷新属性
          </button>
        </div>
      </section>
    </div>
  )
}
