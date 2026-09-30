/// <reference types="vite/client" />

export type PluginConfig = {
  id: string
  name?: string
  version?: string
  match: string | string[]
  entry?: string
  logo?: string
  description?: string
  [key: string]: unknown
}

export type PluginInfo = {
  id: string
  fileName: string
  url: string
  baseUrl: string
  size: number
  mtimeMs: number
  config: PluginConfig
  logoUrl?: string
  kind: 'package' | 'legacy'
}

export interface MiHomeApi {
  platform: NodeJS.Platform
  versions: {
    electron: string
    chrome: string
    node: string
  }
  window?: {
    minimize: () => Promise<void>
    maximize: () => Promise<boolean>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void
  }
  shell?: {
    openExternal: (
      url: string,
    ) => Promise<{ ok: true } | { ok: false; error?: string }>
  }
  plugins?: {
    getBaseUrl: () => Promise<string>
    getDir: () => Promise<string>
    list: () => Promise<PluginInfo[]>
    pickAndInstall: () => Promise<
      | {
          ok: true
          plugins: PluginInfo[]
          failed?: { fileName: string; error: string }[]
        }
      | { ok: false; canceled?: boolean; error?: string }
    >
    remove: (fileName: string) => Promise<boolean>
    revealDir: () => Promise<string>
  }
}

declare global {
  interface Window {
    miHome?: MiHomeApi
  }
}

export {}
