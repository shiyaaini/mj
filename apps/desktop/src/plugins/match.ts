import type { PluginInfo } from '@/vite-env'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exact pattern beats longer wildcard; longer wildcard beats shorter. */
export function pluginMatchScore(pattern: string, model: string): number {
  const m = model.trim()
  const pluginId = pattern.trim()
  if (!m || !pluginId) return 0
  if (pluginId === m) return 10_000 + pluginId.length
  if (!pluginId.includes('*')) return 0
  const re = new RegExp(`^${pluginId.split('*').map(escapeRegex).join('.*')}$`)
  if (!re.test(m)) return 0
  return 100 + pluginId.replace(/\*/g, '').length
}

function patternsOf(plugin: PluginInfo): string[] {
  const match = plugin.config?.match
  if (Array.isArray(match)) return match.map(String).filter(Boolean)
  if (typeof match === 'string' && match.trim()) return [match.trim()]
  // Legacy fallback: folder / file id
  return plugin.id ? [plugin.id] : []
}

export function findPluginForModel(
  plugins: PluginInfo[],
  model?: string | null,
): PluginInfo | undefined {
  if (!model?.trim()) return undefined
  let best: PluginInfo | undefined
  let bestScore = 0
  for (const p of plugins) {
    for (const pattern of patternsOf(p)) {
      const score = pluginMatchScore(pattern, model)
      if (score > bestScore) {
        bestScore = score
        best = p
      }
    }
  }
  return best
}
