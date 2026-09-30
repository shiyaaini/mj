import { useEffect, useState } from 'react'
import {
  getThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemePreference,
} from '@/theme'
import './ThemeSwitcher.css'

export function ThemeSwitcher() {
  const [current, setCurrent] = useState<ThemePreference>(() => getThemePreference())

  useEffect(() => subscribeTheme(() => setCurrent(getThemePreference())), [])

  const options: { id: ThemePreference; label: string }[] = [
    { id: 'system', label: '跟随系统' },
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '暗黑' },
  ]

  return (
    <div className="theme-seg" role="group" aria-label="主题">
      {options.map((item) => {
        const active = current === item.id
        return (
          <button
            key={item.id}
            type="button"
            className={active ? 'active' : undefined}
            aria-pressed={active}
            onClick={() => setThemePreference(item.id)}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
