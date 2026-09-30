import { NavLink } from 'react-router-dom'
import type { ReactElement } from 'react'
import logoUrl from '@/assets/logo.png'
import { NAV_LABELS, pickLabel } from '@/labels'
import { useAppStore } from '@/stores/appStore'
import {
  IconDevices,
  IconHome,
  IconProfile,
  IconScenes,
  IconTemplates,
} from './Icons'

const items: {
  to: string
  key: string
  icon: () => ReactElement
  end?: boolean
}[] = [
  { to: '/', key: 'nav.home', icon: IconHome, end: true },
  { to: '/devices', key: 'nav.devices', icon: IconDevices },
  { to: '/scenes', key: 'nav.scenes', icon: IconScenes },
  { to: '/templates', key: 'nav.templates', icon: IconTemplates },
  { to: '/settings', key: 'nav.profile', icon: IconProfile },
]

export function Sidebar() {
  const dataSource = useAppStore((s) => s.dataSource)

  return (
    <aside className="sidebar">
      <div className="sidebar-brand-wrap">
        <img className="sidebar-brand" src={logoUrl} alt="米家" title="米家" />
        <span className="sidebar-brand-text">米家</span>
      </div>
      <nav className="sidebar-nav">
        {items.map(({ to, key, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <Icon />
            <span>{pickLabel(NAV_LABELS, key)}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className={`sidebar-status${dataSource === 'live' ? ' live' : ' mock'}`}>
          <i />
          <span>
            {dataSource === 'live' ? "已连接米家云" : "演示数据"}
          </span>
        </div>
      </div>
    </aside>
  )
}
