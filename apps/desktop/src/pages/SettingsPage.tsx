import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ThemeSwitcher } from '@/components/ThemeSwitcher'
import type { UserProfile } from '@/api/bridge'
import { bridgeApi, getBridgeRedocUrl, getBridgeSwaggerUrl } from '@/api/bridge'
import { useAppStore } from '@/stores/appStore'
import './settings.css'

type Tab = 'general' | 'account' | 'notifications' | 'about'

function fmtTime(ms: number | null | undefined, locale: string) {
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

export function SettingsPage() {
  const navigate = useNavigate()
  const logout = useAppStore((s) => s.logout)
  const dataSource = useAppStore((s) => s.dataSource)
  const devices = useAppStore((s) => s.devices)
  const scenes = useAppStore((s) => s.scenes)
  const userProfile = useAppStore((s) => s.userProfile)
  const refreshUserProfile = useAppStore((s) => s.refreshUserProfile)
  const showToast = useAppStore((s) => s.showToast)
  const [tab, setTab] = useState<Tab>('account')
  const [launch, setLaunch] = useState(false)
  const [autoUpdate, setAutoUpdate] = useState(true)
  const [loadingProfile, setLoadingProfile] = useState(false)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'account', label: "账号与安全" },
    { id: 'general', label: "通用" },
    { id: 'notifications', label: "消息通知" },
    { id: 'about', label: "关于米家" },
  ]

  const mockProfile: UserProfile = useMemo(
    () => ({
      authenticated: true,
      mode: 'mock',
      user_id: 'demo-user',
      display_name: "演示用户",
      nickname: "演示用户",
      avatar_url: null,
      home_name: null,
      home_count: 1,
      device_count: devices.length,
      scene_count: scenes.length,
      login_time: null,
      expire_time: null,
    }),
    [devices.length, scenes.length],
  )

  const profile = dataSource === 'live' ? userProfile : mockProfile

  useEffect(() => {
    if (dataSource !== 'live') return
    // Cache hit: do not hit network. Only fetch when missing.
    if (userProfile?.user_id || userProfile?.nickname || userProfile?.avatar_url) return
    let cancelled = false
    setLoadingProfile(true)
    void refreshUserProfile(false).finally(() => {
      if (!cancelled) setLoadingProfile(false)
    })
    return () => {
      cancelled = true
    }
  }, [dataSource, userProfile, refreshUserProfile])

  const displayName = useMemo(() => {
    if (profile?.nickname) return profile.nickname
    if (profile?.display_name) return profile.display_name
    if (dataSource === 'mock') return "演示用户"
    return "小米用户"
  }, [profile, dataSource])

  const avatarText = useMemo(() => {
    if (displayName && displayName !== "小米用户") return displayName.slice(0, 1)
    const id = profile?.user_id || ''
    if (id && /^\d+$/.test(id)) return id.slice(-2)
    return '米'
  }, [profile, displayName])

  const [avatarFailed, setAvatarFailed] = useState(false)
  useEffect(() => {
    setAvatarFailed(false)
  }, [profile?.avatar_url])

  const deviceCount = devices.length
  const sceneCount = scenes.length
  const homeCount = profile?.home_count ?? (dataSource === 'live' ? 0 : 1)

  const handleLogout = async () => {
    try {
      if (dataSource === 'live') {
        await bridgeApi.logout()
      }
    } catch {
      /* bridge may be offline in demo */
    }
    logout()
    showToast('已退出登录')
    navigate('/login', { replace: true })
  }

  const openInBrowser = async (url: string) => {
    try {
      if (window.miHome?.shell?.openExternal) {
        const result = await window.miHome.shell.openExternal(url)
        if (result.ok === false) {
          showToast(result.error || '打开浏览器失败')
        }
        return
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '打开浏览器失败')
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>我的</h1>
        </div>
      </header>

      <section className="profile-card panel">
        <div className="profile-main">
          <div className="profile-avatar" aria-hidden>
            {profile?.avatar_url && !avatarFailed ? (
              <img
                src={profile.avatar_url}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              avatarText
            )}
          </div>
          <div className="profile-info">
            <div className="profile-name-row">
              <h2>{displayName}</h2>
              <span className={`profile-badge${dataSource === 'live' ? ' live' : ''}`}>
                {dataSource === 'live' ? "已登录" : "演示"}
              </span>
            </div>
            <p className="profile-id">
              小米 ID
              <strong>{profile?.user_id || (loadingProfile ? '…' : '—')}</strong>
            </p>
            {profile?.home_name ? (
              <p className="profile-home">
                家庭
                <strong>{profile.home_name}</strong>
              </p>
            ) : null}
          </div>
        </div>

        <div className="profile-stats">
          <div>
            <strong>{deviceCount}</strong>
            <span>设备</span>
          </div>
          <div>
            <strong>{sceneCount}</strong>
            <span>场景</span>
          </div>
          <div>
            <strong>{homeCount}</strong>
            <span>家庭</span>
          </div>
        </div>

        <div className="profile-meta">
          <div>
            <span>登录时间</span>
            <strong>{fmtTime(profile?.login_time, 'zh-CN')}</strong>
          </div>
          <div>
            <span>凭证到期</span>
            <strong>{fmtTime(profile?.expire_time, 'zh-CN')}</strong>
          </div>
        </div>
      </section>

      <div className="settings-layout">
        <nav className="settings-nav panel">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? 'active' : ''}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <section className="settings-card panel">
          {tab === 'general' && (
            <>
              <div className="setting-row">
                <div>
                  <h3>开机启动</h3>
                </div>
                <button
                  type="button"
                  className={`switch${launch ? ' on' : ''}`}
                  onClick={() => setLaunch((v) => !v)}
                />
              </div>
              <div className="setting-row">
                <div>
                  <h3>主题</h3>
                  <p>浅色、暗黑或跟随系统</p>
                </div>
                <ThemeSwitcher />
              </div>
              <div className="setting-row">
                <div>
                  <h3>自动更新</h3>
                </div>
                <button
                  type="button"
                  className={`switch${autoUpdate ? ' on' : ''}`}
                  onClick={() => setAutoUpdate((v) => !v)}
                />
              </div>
              <div className="setting-row">
                <div>
                  <h3>清除缓存</h3>
                  <p>128 MB</p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => showToast("即将推出")}
                >
                  清除缓存
                </button>
              </div>
            </>
          )}

          {tab === 'account' && (
            <>
              <div className="setting-row">
                <div>
                  <h3>当前账号</h3>
                  <p>{displayName}</p>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <h3>昵称</h3>
                  <p>{profile?.nickname || displayName}</p>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <h3>小米 ID</h3>
                  <p className="mono">{profile?.user_id || '—'}</p>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <h3>登录方式</h3>
                  <p>
                    {dataSource === 'live'
                      ? "米家 App 扫码"
                      : "演示模式"}
                  </p>
                </div>
              </div>
              <button type="button" className="btn btn-danger" onClick={() => void handleLogout()}>
                退出登录
              </button>
            </>
          )}

          {tab === 'notifications' && <p className="empty">即将推出</p>}

          {tab === 'about' && (
            <>
              <div className="setting-row">
                <div>
                  <h3>当前版本</h3>
                  <p>0.1.0</p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => showToast('即将推出')}
                >
                  检查更新
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Bridge API 文档</h3>
                  <p>在系统浏览器中打开 FastAPI Swagger（/docs）</p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void openInBrowser(getBridgeSwaggerUrl())}
                >
                  打开文档
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <h3>ReDoc</h3>
                  <p>备用阅读视图（/redoc）</p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void openInBrowser(getBridgeRedocUrl())}
                >
                  打开 ReDoc
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
