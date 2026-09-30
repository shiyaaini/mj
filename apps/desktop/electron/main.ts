import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridgeSupervisor, stopBridgeSupervisor } from './bridgeProcess'
import { bindPluginsIpc, stopPluginsHttpServer } from './plugins'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

// Disable GPU / hardware acceleration (must run before app ready).
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
// System HTTP proxy must not capture loopback Bridge (127.0.0.1:8787).
app.commandLine.appendSwitch(
  'proxy-bypass-list',
  '<-loopback>;127.0.0.1;localhost;::1',
)

const SPLASH_MIN_MS = 1400

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let tray: Tray | null = null
let launching = true
let quitting = false

function resolveAppIcon(): string | undefined {
  const root = process.env.APP_ROOT || path.join(__dirname, '..')
  const candidates = [
    path.join(root, 'build/icon.png'),
    path.join(root, 'electron/logo.png'),
    path.join(root, 'public/logo.png'),
    path.join(root, 'dist/logo.png'),
    path.join(root, 'src/assets/logo.png'),
  ]
  return candidates.find((p) => fs.existsSync(p))
}

function resolveSplashHtml(): string | null {
  const root = process.env.APP_ROOT || path.join(__dirname, '..')
  const candidates = [
    path.join(root, 'dist/splash.html'),
    path.join(root, 'public/splash.html'),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
  ensureTray()
}

function quitApp() {
  quitting = true
  app.quit()
}

function ensureTray() {
  if (tray) return

  const iconPath = resolveAppIcon()
  const image = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()
  const trayIcon =
    process.platform === 'win32' && !image.isEmpty()
      ? image.resize({ width: 16, height: 16 })
      : image

  tray = new Tray(trayIcon.isEmpty() ? image : trayIcon)
  tray.setToolTip('米家')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开米家',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => quitApp(),
      },
    ]),
  )

  tray.on('double-click', () => showMainWindow())
  if (process.platform === 'win32') {
    tray.on('click', () => showMainWindow())
  }
}

function destroyTray() {
  if (!tray) return
  try {
    tray.destroy()
  } catch {
    /* ignore */
  }
  tray = null
}

function createSplashWindow() {
  const splashHtml = resolveSplashHtml()
  if (!splashHtml) {
    console.warn('[splash] splash.html not found, skip')
    return
  }

  const iconPath = resolveAppIcon()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined

  splashWindow = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    transparent: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0b1016',
    title: '米家',
    icon: icon && !icon.isEmpty() ? icon : iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  splashWindow.setMenuBarVisibility(false)
  splashWindow.on('closed', () => {
    splashWindow = null
  })
  splashWindow.once('ready-to-show', () => {
    splashWindow?.show()
  })
  void splashWindow.loadFile(splashHtml)
}

function closeSplash() {
  if (!splashWindow) return
  try {
    if (!splashWindow.isDestroyed()) splashWindow.close()
  } catch {
    /* ignore */
  }
  splashWindow = null
}

function createWindow() {
  Menu.setApplicationMenu(null)

  const iconPath = resolveAppIcon()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    title: '米家',
    icon: icon && !icon.isEmpty() ? icon : iconPath,
    backgroundColor: '#12161d',
    show: false,
    frame: false,
    transparent: false,
    autoHideMenuBar: true,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.setMenuBarVisibility(false)
  if (icon && !icon.isEmpty()) {
    mainWindow.setIcon(icon)
  }

  // Close button / Alt+F4 → hide to tray (unless really quitting)
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    hideToTray()
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized', false)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function revealMainWindow(splashShownAt: number) {
  const show = () => {
    closeSplash()
    ensureTray()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }

  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt))
  if (wait > 0) setTimeout(show, wait)
  else show()
}

function bindWindowIpc() {
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })
  ipcMain.handle('window:maximize', () => {
    const win = mainWindow
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', () => {
    hideToTray()
  })
  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false
  })
  ipcMain.handle('shell:openExternal', async (_e, rawUrl: unknown) => {
    const url = String(rawUrl || '').trim()
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false as const, error: '仅支持 http(s) 链接' }
    }
    try {
      await shell.openExternal(url)
      return { ok: true as const }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })
}

app.whenReady().then(async () => {
  try {
    const { session } = await import('electron')
    await session.defaultSession.setProxy({
      mode: 'system',
      proxyBypassRules: '<-loopback>;127.0.0.1;localhost;::1',
    })
  } catch (err) {
    console.warn('[proxy] failed to set bypass rules', err)
  }

  const iconPath = resolveAppIcon()
  if (iconPath && process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(iconPath)
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
  }

  bindWindowIpc()

  const splashShownAt = Date.now()
  createSplashWindow()

  try {
    const bridge = await startBridgeSupervisor()
    if (!bridge.ok && !bridge.skipped) {
      console.warn(
        '[bridge] not ready yet — UI will retry; ensure uv is installed and apps/bridge works',
      )
    }
  } catch (err) {
    console.error('[bridge] supervisor failed', err)
  }
  try {
    await bindPluginsIpc(() => mainWindow)
  } catch (err) {
    console.error('[plugins] failed to start HTTP server', err)
  }

  createWindow()
  mainWindow?.once('ready-to-show', () => {
    revealMainWindow(splashShownAt)
    launching = false
  })
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      revealMainWindow(splashShownAt)
    }
    launching = false
  }, SPLASH_MIN_MS + 8000)

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep running in tray; only quit via tray menu / quitApp()
  if (launching) return
})

let cleaningUp = false

app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault()
    return
  }
  if (cleaningUp) return
  event.preventDefault()
  cleaningUp = true
  closeSplash()
  destroyTray()
  void (async () => {
    try {
      await stopBridgeSupervisor()
    } catch (err) {
      console.error('[bridge] stop failed', err)
    }
    stopPluginsHttpServer()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeAllListeners('close')
      mainWindow.destroy()
    }
    mainWindow = null
    app.exit(0)
  })()
})
