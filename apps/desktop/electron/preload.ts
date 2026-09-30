import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('miHome', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize') as Promise<boolean>,
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    onMaximizedChange: (cb: (maximized: boolean) => void) => {
      const listener = (_: Electron.IpcRendererEvent, value: boolean) => cb(value)
      ipcRenderer.on('window:maximized', listener)
      return () => ipcRenderer.removeListener('window:maximized', listener)
    },
  },
  shell: {
    openExternal: (url: string) =>
      ipcRenderer.invoke('shell:openExternal', url) as Promise<
        { ok: true } | { ok: false; error?: string }
      >,
  },
  plugins: {
    getBaseUrl: () => ipcRenderer.invoke('plugins:getBaseUrl') as Promise<string>,
    getDir: () => ipcRenderer.invoke('plugins:getDir') as Promise<string>,
    list: () => ipcRenderer.invoke('plugins:list'),
    pickAndInstall: () => ipcRenderer.invoke('plugins:pickAndInstall'),
    remove: (fileName: string) => ipcRenderer.invoke('plugins:remove', fileName),
    revealDir: () => ipcRenderer.invoke('plugins:revealDir') as Promise<string>,
  },
})
