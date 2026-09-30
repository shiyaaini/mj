export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'mi-home-theme'
const CHANGE_EVENT = 'mi-home-theme'

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function getThemePreference(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  return 'system'
}

export function resolveTheme(pref: ThemePreference = getThemePreference()): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref
}

export function applyTheme(pref: ThemePreference = getThemePreference()) {
  const resolved = resolveTheme(pref)
  const root = document.documentElement
  root.dataset.theme = resolved
  root.dataset.themePref = pref
  root.style.colorScheme = resolved
}

export function setThemePreference(pref: ThemePreference) {
  localStorage.setItem(STORAGE_KEY, pref)
  applyTheme(pref)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeTheme(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

export function initTheme() {
  applyTheme()
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    if (getThemePreference() === 'system') {
      applyTheme('system')
      window.dispatchEvent(new Event(CHANGE_EVENT))
    }
  })
}

initTheme()
