import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { bridgeApi, BridgeError } from '@/api/bridge'
import { LOGIN_FEATURE_LABELS, pickLabel } from '@/labels'
import { useAppStore } from '@/stores/appStore'
import logoUrl from '@/assets/logo.png'
import './login.css'

function IconUser() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19c1.6-3 3.8-4.2 6.5-4.2S16.9 16 18.5 19" />
    </svg>
  )
}

function IconLock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

function IconEye({ off }: { off?: boolean }) {
  return off ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6A2 2 0 0 0 13.4 13.4" />
      <path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c5.5 0 9.5 4.5 10.5 7-.4 1-1.2 2.4-2.5 3.7" />
      <path d="M6.1 6.1C4.4 7.4 3.3 9 2.5 12c1 2.5 5 7 9.5 7 1.4 0 2.7-.3 3.9-.8" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M2.5 12C3.5 9.5 7.5 5 12 5s8.5 4.5 9.5 7c-1 2.5-5 7-9.5 7s-8.5-4.5-9.5-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function IconHomeFeat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-5v-5H10v5H5a1 1 0 0 1-1-1v-8Z" />
    </svg>
  )
}

function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M12 3 5 6v6c0 4.2 2.8 7.8 7 9 4.2-1.2 7-4.8 7-9V6l-7-3Z" />
    </svg>
  )
}

function IconLeaf() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M5 19c8-1 12-7 13-14-7 1-13 5-13 14Z" />
      <path d="M8 14c2-1 4-3 5-5" />
    </svg>
  )
}

function IconBox() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="M12 12 4 7M12 12l8-5M12 12v10" />
    </svg>
  )
}

export function LoginPage() {
  const login = useAppStore((s) => s.login)
  const authenticated = useAppStore((s) => s.authenticated)
  const showToast = useAppStore((s) => s.showToast)
  const [showPassword, setShowPassword] = useState(false)
  const [mode, setMode] = useState<'account' | 'qr'>('qr')
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [qrMessage, setQrMessage] = useState<string | null>(null)
  const [qrLoading, setQrLoading] = useState(false)
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null)
  const pollRef = useRef<number | null>(null)

  const stopPoll = () => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const finishLogin = (source: 'mock' | 'live' = 'mock') => {
    stopPoll()
    login(source)
  }

  const startQr = async () => {
    setQrLoading(true)
    setQrMessage(null)
    try {
      const started = await bridgeApi.startQrLogin()
      setBridgeOnline(true)
      if (started.status === 'authenticated') {
        finishLogin('live')
        return
      }
      setQrImageUrl(started.qr_image_url ?? null)
      setQrMessage(started.message)
      stopPoll()
      pollRef.current = window.setInterval(async () => {
        try {
          const status = await bridgeApi.qrStatus()
          if (status.authenticated || status.status === 'success') {
            finishLogin('live')
            return
          }
          if (status.status === 'error') {
            stopPoll()
            setQrMessage(status.message || "扫码登录失败，请重试")
          }
          if (status.qr_image_url) setQrImageUrl(status.qr_image_url)
        } catch (err) {
          stopPoll()
          setQrMessage(err instanceof Error ? err.message : "扫码登录失败，请重试")
        }
      }, 2000)
    } catch (err) {
      setBridgeOnline(false)
      setQrImageUrl(null)
      setQrMessage(
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : "后端未启动：请先运行 pnpm bridge:dev",
      )
    } finally {
      setQrLoading(false)
    }
  }

  useEffect(() => {
    void bridgeApi
      .health()
      .then((h) => {
        setBridgeOnline(true)
        if (h.authenticated) finishLogin('live')
      })
      .catch(() => setBridgeOnline(false))

    return () => stopPoll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (mode === 'qr') void startQr()
    else stopPoll()
    return () => stopPoll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  if (authenticated) return <Navigate to="/" replace />

  const features = [
    { key: 'home', icon: IconHomeFeat },
    { key: 'security', icon: IconShield },
    { key: 'energy', icon: IconLeaf },
    { key: 'life', icon: IconBox },
  ] as const

  return (
    <div className="login-page">
      <div className="login-bg" aria-hidden />

      <div className="login-content">
        <section className="login-brand">
          <div className="brand-row">
            <img className="brand-logo" src={logoUrl} alt="米家" />
            <span className="brand-name">米家</span>
          </div>
          <h1 className="brand-slogan">智能生活，从米家开始</h1>
          <ul className="brand-features">
            {features.map(({ key, icon: Icon }) => (
              <li key={key}>
                <span className="feat-icon">
                  <Icon />
                </span>
                <span>{pickLabel(LOGIN_FEATURE_LABELS, key)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="login-card">
          <h2>登录米家账号</h2>
          <p className="login-card-sub">一个账号，控制所有米家智能设备</p>
          {bridgeOnline === false ? (
            <p className="bridge-hint">后端未启动：请先运行 pnpm bridge:dev</p>
          ) : null}

          <div className="login-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'account'}
              className={mode === 'account' ? 'active' : ''}
              onClick={() => setMode('account')}
            >
              账号登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'qr'}
              className={mode === 'qr' ? 'active' : ''}
              onClick={() => setMode('qr')}
            >
              扫码登录
            </button>
          </div>

          {mode === 'account' ? (
            <>
              <form
                className="login-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  showToast("正式登录请使用扫码；账号密码将在后续接入")
                }}
              >
                <label className="field">
                  <span className="field-icon">
                    <IconUser />
                  </span>
                  <input
                    type="text"
                    autoComplete="username"
                    placeholder="手机号 / 小米账号 / 邮箱"
                  />
                </label>

                <label className="field">
                  <span className="field-icon">
                    <IconLock />
                  </span>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="请输入密码"
                  />
                  <button
                    type="button"
                    className="field-action"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    <IconEye off={showPassword} />
                  </button>
                </label>

                <button type="submit" className="login-submit">
                  登录
                </button>
              </form>

              <div className="login-links">
                <button type="button">注册账号</button>
                <button type="button">忘记密码</button>
              </div>

              <button
                type="button"
                className="btn-ghost-login demo-enter"
                onClick={() => finishLogin('mock')}
              >
                演示模式进入
              </button>
            </>
          ) : (
            <div className="qr-panel">
              <div className="qr-frame">
                {qrImageUrl ? (
                  <img className="qr-image" src={qrImageUrl} alt="QR" />
                ) : (
                  <>
                    <div className="qr-pattern" />
                    <img className="qr-center-logo" src={logoUrl} alt="" />
                  </>
                )}
              </div>
              <p className="qr-hint">打开米家 App，扫描二维码登录</p>
              <p className="qr-mock">{qrMessage || (qrLoading ? "正在获取二维码…" : '')}</p>
              <div className="qr-actions">
                <button
                  type="button"
                  className="btn-ghost-login"
                  onClick={() => void startQr()}
                  disabled={qrLoading}
                >
                  刷新二维码
                </button>
                <button type="button" className="login-submit" onClick={() => finishLogin('mock')}>
                  演示模式进入
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
