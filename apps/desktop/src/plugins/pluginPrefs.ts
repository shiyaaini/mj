const STORAGE_KEY = 'mi-home-plugin-prefs-v1'

type Prefs = {
  /** fileName → enabled; missing means enabled */
  enabled: Record<string, boolean>
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { enabled: {} }
    const parsed = JSON.parse(raw) as Prefs
    return {
      enabled:
        parsed?.enabled && typeof parsed.enabled === 'object' ? parsed.enabled : {},
    }
  } catch {
    return { enabled: {} }
  }
}

function writePrefs(prefs: Prefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}

export function isPluginEnabled(fileName: string): boolean {
  const v = readPrefs().enabled[fileName]
  return v !== false
}

export function setPluginEnabled(fileName: string, enabled: boolean) {
  const prefs = readPrefs()
  prefs.enabled[fileName] = enabled
  writePrefs(prefs)
}

export function removePluginPref(fileName: string) {
  const prefs = readPrefs()
  delete prefs.enabled[fileName]
  writePrefs(prefs)
}

export function readEnabledMap(): Record<string, boolean> {
  return { ...readPrefs().enabled }
}
