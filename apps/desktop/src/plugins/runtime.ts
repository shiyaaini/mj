import * as React from 'react'
import * as JSXRuntime from 'react/jsx-runtime'
import { createRoot, type Root } from 'react-dom/client'
import { transform } from 'sucrase'

const STYLE_ATTR = 'data-react-plugin-style'
const roots = new WeakMap<HTMLElement, Root>()
/** Bumped on unmount / newer mount so in-flight async mounts abort safely. */
const mountGeneration = new WeakMap<HTMLElement, number>()

/** Shared with blob modules — CSP forbids `new Function` / eval. */
const PLUGIN_REACT_KEY = '__miPluginReact'
const PLUGIN_JSX_KEY = '__miPluginJsx'

type PluginComponent = React.ComponentType<Record<string, unknown>>
type PluginModule = {
  default?: PluginComponent
}

/** Compiled component cache: same file reopens without Sucrase + import. */
const componentCache = new Map<string, Promise<PluginComponent>>()

declare global {
  interface Window {
    __miPluginReact?: typeof React
    __miPluginJsx?: typeof JSXRuntime
  }
}

function clearInjectedStyles(scope?: string) {
  const sel = scope
    ? `style[${STYLE_ATTR}="${scope}"]`
    : `style[${STYLE_ATTR}]`
  document.querySelectorAll(sel).forEach((el) => el.remove())
}

function isTsx(url: string) {
  return /\.tsx($|\?)/i.test(url)
}

function ensurePluginGlobals() {
  window[PLUGIN_REACT_KEY] = React
  window[PLUGIN_JSX_KEY] = JSXRuntime
}

function cacheKeyFor(pluginUrl: string, cacheKey?: string) {
  return cacheKey || pluginUrl
}

function nextGeneration(container: HTMLElement) {
  const gen = (mountGeneration.get(container) ?? 0) + 1
  mountGeneration.set(container, gen)
  return gen
}

function disposeRoot(container: HTMLElement) {
  const root = roots.get(container)
  if (root) {
    roots.delete(container)
    try {
      root.unmount()
    } catch {
      /* already unmounted */
    }
  }
  container.innerHTML = ''
}

async function compilePluginComponent(pluginUrl: string): Promise<PluginComponent> {
  const res = await fetch(pluginUrl)
  if (!res.ok) {
    throw new Error(`${res.statusText} ${pluginUrl}`)
  }
  const source = await res.text()
  const { code } = transform(source, {
    transforms: isTsx(pluginUrl)
      ? ['typescript', 'jsx', 'imports']
      : ['jsx', 'imports'],
    jsxRuntime: 'automatic',
    production: true,
  })

  ensurePluginGlobals()

  const blobSource = `
const exports = {};
const module = { exports };
function require(name) {
  if (name === 'react') return globalThis.${PLUGIN_REACT_KEY};
  if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') {
    return globalThis.${PLUGIN_JSX_KEY};
  }
  throw new Error('插件不允许 import "' + name + '"（仅支持 react）');
}
${code}
export default module.exports.default;
`

  const blobUrl = URL.createObjectURL(
    new Blob([blobSource], { type: 'text/javascript' }),
  )
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as PluginModule
    const Component = mod.default
    if (typeof Component !== 'function') {
      throw new Error('插件必须 default export 一个 React 组件')
    }
    return Component
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0)
  }
}

async function loadPluginComponent(
  pluginUrl: string,
  cacheKey?: string,
): Promise<PluginComponent> {
  const key = cacheKeyFor(pluginUrl, cacheKey)
  const hit = componentCache.get(key)
  if (hit) return hit

  const pending = compilePluginComponent(pluginUrl).catch((err) => {
    componentCache.delete(key)
    throw err
  })
  componentCache.set(key, pending)
  return pending
}

/** Warm cache in background (e.g. after plugins list loads). */
export function prefetchReactPlugin(pluginUrl: string, cacheKey?: string) {
  void loadPluginComponent(pluginUrl, cacheKey).catch(() => {
    /* prefetch is best-effort */
  })
}

export function invalidatePluginCache(cacheKeyOrUrl?: string) {
  if (!cacheKeyOrUrl) {
    componentCache.clear()
    return
  }
  for (const key of [...componentCache.keys()]) {
    if (key === cacheKeyOrUrl || key.startsWith(cacheKeyOrUrl)) {
      componentCache.delete(key)
    }
  }
}

export function pluginCacheKey(plugin: {
  fileName: string
  mtimeMs: number
  size: number
}) {
  return `${plugin.fileName}:${plugin.mtimeMs}:${plugin.size}`
}

export type MountReactPluginOptions = {
  scopeClass?: string
  styleScope?: string
  /** Props passed to the plugin root component. */
  props?: Record<string, unknown>
  /** Stable identity for compile cache; use pluginCacheKey(plugin). */
  cacheKey?: string
}

export type MountReactPluginHandle = {
  update: (props?: Record<string, unknown>) => void
  unmount: () => void
}

const noopHandle: MountReactPluginHandle = {
  update() {},
  unmount() {},
}

export async function mountReactPlugin(
  pluginUrl: string,
  container: HTMLElement,
  options: MountReactPluginOptions = {},
): Promise<MountReactPluginHandle> {
  const scopeClass = options.scopeClass ?? 'react-plugin-root'
  const styleScope = options.styleScope ?? scopeClass
  const gen = nextGeneration(container)

  disposeRoot(container)
  clearInjectedStyles(styleScope)
  container.classList.add(scopeClass)

  const Component = await loadPluginComponent(pluginUrl, options.cacheKey)

  // Superseded by a newer mount() or unmountReactPlugin() during await
  if (mountGeneration.get(container) !== gen) {
    return noopHandle
  }

  let alive = true
  const root = createRoot(container)
  roots.set(container, root)

  let currentProps = { ...(options.props ?? {}) }

  const isCurrent = () =>
    alive && mountGeneration.get(container) === gen && roots.get(container) === root

  const render = () => {
    if (!isCurrent()) return
    root.render(
      React.createElement(Component, {
        ...currentProps,
        key: pluginUrl,
      }),
    )
  }

  render()

  return {
    update(next) {
      if (!isCurrent()) return
      if (next) currentProps = { ...currentProps, ...next }
      render()
    },
    unmount() {
      if (!alive) return
      alive = false
      if (mountGeneration.get(container) === gen) {
        nextGeneration(container)
      }
      if (roots.get(container) === root) {
        disposeRoot(container)
      }
      clearInjectedStyles(styleScope)
    },
  }
}

export function unmountReactPlugin(container?: HTMLElement, styleScope?: string) {
  if (container) {
    nextGeneration(container)
    disposeRoot(container)
  }
  if (styleScope) clearInjectedStyles(styleScope)
  else if (!container) clearInjectedStyles()
}
