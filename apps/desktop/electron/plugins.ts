import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export type PluginConfig = {
  /** Unique folder id under userData/plugins */
  id: string
  name?: string
  version?: string
  /** Model match string or list; supports `*` wildcards */
  match: string | string[]
  /** Entry relative to package root; default index.jsx / index.tsx */
  entry?: string
  /** Logo / icon relative path, e.g. assets/logo.png */
  logo?: string
  description?: string
  [key: string]: unknown
}

export type PluginInfo = {
  id: string
  /** Folder name (or legacy single-file name) used by remove IPC */
  fileName: string
  /** Absolute-style URL to the entry jsx/tsx */
  url: string
  /** Base URL of the package folder (for assets) */
  baseUrl: string
  size: number
  mtimeMs: number
  config: PluginConfig
  logoUrl?: string
  kind: 'package' | 'legacy'
}

const LEGACY_EXT = /\.(jsx|tsx)$/i
const ZIP_EXT = /\.zip$/i

let pluginsDir = ''
let server: http.Server | null = null
let baseUrl = ''
let listenPromise: Promise<string> | null = null

function ensurePluginsDir(): string {
  if (!pluginsDir) {
    pluginsDir = path.join(app.getPath('userData'), 'plugins')
  }
  fs.mkdirSync(pluginsDir, { recursive: true })
  return pluginsDir
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jsx' || ext === '.tsx' || ext === '.ts' || ext === '.js') {
    return 'text/plain; charset=utf-8'
  }
  if (ext === '.mjs') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.woff') return 'font/woff'
  if (ext === '.woff2') return 'font/woff2'
  return 'application/octet-stream'
}

function safeResolveUnderPlugins(urlPath: string): string | null {
  const dir = ensurePluginsDir()
  const decoded = decodeURIComponent(urlPath.split('?')[0] || '/')
  const rel = decoded.replace(/^\/+/, '')
  if (!rel || rel.includes('\0')) return null
  const resolved = path.resolve(dir, rel)
  const root = path.resolve(dir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

function encodePathSegments(rel: string): string {
  return rel
    .split(/[/\\]+/)
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/')
}

function dirSizeBytes(dir: string): number {
  let total = 0
  const walk = (p: string) => {
    for (const name of fs.readdirSync(p)) {
      const full = path.join(p, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) walk(full)
      else total += st.size
    }
  }
  walk(dir)
  return total
}

function sanitizeId(raw: string): string {
  const s = String(raw || '')
    .trim()
    .replace(/[^\w.\-()\u4e00-\u9fff]+/g, '_')
    .replace(/^\.+/, '')
  return s || 'plugin'
}

function findEntryFile(pkgDir: string, preferred?: string): string | null {
  if (preferred) {
    const full = path.join(pkgDir, preferred)
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return preferred.replace(/\\/g, '/')
    }
  }
  for (const name of ['index.jsx', 'index.tsx']) {
    const full = path.join(pkgDir, name)
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return name
  }
  return null
}

function readConfig(pkgDir: string): PluginConfig {
  const cfgPath = path.join(pkgDir, 'config.json')
  if (!fs.existsSync(cfgPath)) {
    throw new Error('压缩包内必须包含 config.json')
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  } catch {
    throw new Error('config.json 不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.json 必须是对象')
  }
  const obj = raw as Record<string, unknown>
  const id = sanitizeId(String(obj.id || path.basename(pkgDir)))
  const match = obj.match
  if (
    match == null ||
    (typeof match !== 'string' &&
      !(Array.isArray(match) && match.every((x) => typeof x === 'string')))
  ) {
    throw new Error('config.json 必须包含 match（字符串或字符串数组）')
  }
  const entry =
    typeof obj.entry === 'string' && obj.entry.trim() ? obj.entry.trim() : undefined
  return {
    ...obj,
    id,
    match: match as string | string[],
    entry,
    name: typeof obj.name === 'string' ? obj.name : undefined,
    version: typeof obj.version === 'string' ? obj.version : undefined,
    logo: typeof obj.logo === 'string' ? obj.logo : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
  }
}

function validatePackageDir(pkgDir: string): { config: PluginConfig; entry: string } {
  const config = readConfig(pkgDir)
  const entry = findEntryFile(pkgDir, config.entry)
  if (!entry) {
    throw new Error('压缩包内必须包含 index.jsx 或 index.tsx（或 config.entry 指向的入口）')
  }
  if (config.logo) {
    const logoPath = path.join(pkgDir, config.logo)
    if (!fs.existsSync(logoPath) || !fs.statSync(logoPath).isFile()) {
      throw new Error(`config.logo 文件不存在：${config.logo}`)
    }
  }
  return { config, entry }
}

function toPackageInfo(dirName: string): PluginInfo | null {
  if (!baseUrl) return null
  const dir = ensurePluginsDir()
  const full = path.join(dir, dirName)
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return null
  if (!fs.existsSync(path.join(full, 'config.json'))) return null
  try {
    const { config, entry } = validatePackageDir(full)
    const st = fs.statSync(full)
    const folderUrl = `${baseUrl}/${encodePathSegments(dirName)}`
    return {
      id: config.id || dirName,
      fileName: dirName,
      url: `${folderUrl}/${encodePathSegments(entry)}`,
      baseUrl: folderUrl,
      size: dirSizeBytes(full),
      mtimeMs: st.mtimeMs,
      config: { ...config, id: config.id || dirName },
      logoUrl: config.logo
        ? `${folderUrl}/${encodePathSegments(config.logo)}`
        : undefined,
      kind: 'package',
    }
  } catch (err) {
    console.warn(`[plugins] skip invalid package ${dirName}:`, err)
    return null
  }
}

/** Legacy single-file plugins (pre zip packages). */
function toLegacyInfo(fileName: string): PluginInfo | null {
  if (!LEGACY_EXT.test(fileName) || !baseUrl) return null
  const dir = ensurePluginsDir()
  const full = path.join(dir, fileName)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null
  const st = fs.statSync(full)
  const id = path.basename(fileName, path.extname(fileName))
  const url = `${baseUrl}/${encodeURIComponent(fileName)}`
  return {
    id,
    fileName,
    url,
    baseUrl: baseUrl,
    size: st.size,
    mtimeMs: st.mtimeMs,
    config: {
      id,
      name: id,
      match: id,
      description: '旧版单文件插件（建议改为 zip 包）',
    },
    kind: 'legacy',
  }
}

function listPluginsSync(): PluginInfo[] {
  const dir = ensurePluginsDir()
  if (!baseUrl) return []
  const out: PluginInfo[] = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      const info = toPackageInfo(name)
      if (info) out.push(info)
    } else if (st.isFile() && LEGACY_EXT.test(name)) {
      const info = toLegacyInfo(name)
      if (info) out.push(info)
    }
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName))
}

function rmrf(target: string) {
  fs.rmSync(target, { recursive: true, force: true })
}

function assertSafeZipEntries(zip: AdmZip) {
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/')
    if (name.includes('\0') || name.split('/').some((p) => p === '..')) {
      throw new Error(`压缩包含非法路径：${entry.entryName}`)
    }
  }
}

/** Prefer package root with config.json; unwrap single top-level folder. */
function resolvePackageRoot(extractDir: string): string {
  if (fs.existsSync(path.join(extractDir, 'config.json'))) return extractDir
  const kids = fs
    .readdirSync(extractDir)
    .map((n) => path.join(extractDir, n))
    .filter((p) => fs.statSync(p).isDirectory())
  if (kids.length === 1 && fs.existsSync(path.join(kids[0], 'config.json'))) {
    return kids[0]
  }
  throw new Error('未找到 config.json（可放在压缩包根目录，或唯一子文件夹内）')
}

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name)
    const to = path.join(dest, name)
    const st = fs.statSync(from)
    if (st.isDirectory()) copyDirSync(from, to)
    else fs.copyFileSync(from, to)
  }
}

async function installZipFile(src: string): Promise<PluginInfo> {
  if (!ZIP_EXT.test(src)) {
    throw new Error('请选择 .zip 插件包')
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-plugin-'))
  try {
    const zip = new AdmZip(src)
    assertSafeZipEntries(zip)
    zip.extractAllTo(tmpRoot, true)

    const pkgRoot = resolvePackageRoot(tmpRoot)
    const { config } = validatePackageDir(pkgRoot)
    const dirName = sanitizeId(config.id)
    config.id = dirName

    const cfgOnDisk = {
      ...config,
      id: dirName,
    }
    fs.writeFileSync(
      path.join(pkgRoot, 'config.json'),
      `${JSON.stringify(cfgOnDisk, null, 2)}\n`,
      'utf8',
    )

    const dest = path.join(ensurePluginsDir(), dirName)
    if (fs.existsSync(dest)) rmrf(dest)
    copyDirSync(pkgRoot, dest)

    const plugin = toPackageInfo(dirName)
    if (!plugin) throw new Error('安装后读取失败')
    return plugin
  } finally {
    rmrf(tmpRoot)
  }
}

async function pickAndInstall(win: BrowserWindow | null): Promise<
  | {
      ok: true
      plugins: PluginInfo[]
      /** Present when some files failed while others succeeded */
      failed?: { fileName: string; error: string }[]
    }
  | { ok: false; canceled?: boolean; error?: string }
> {
  const options: Electron.OpenDialogOptions = {
    title: '选择插件压缩包（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '插件压缩包', extensions: ['zip'] }],
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true }
  }

  await startPluginsHttpServer()

  const plugins: PluginInfo[] = []
  const failed: { fileName: string; error: string }[] = []

  for (const src of result.filePaths) {
    const fileName = path.basename(src)
    try {
      plugins.push(await installZipFile(src))
    } catch (err) {
      failed.push({
        fileName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!plugins.length) {
    const detail = failed.map((f) => `${f.fileName}: ${f.error}`).join('；')
    return { ok: false, error: detail || '安装失败' }
  }

  return failed.length ? { ok: true, plugins, failed } : { ok: true, plugins }
}

function removePlugin(fileName: string): boolean {
  const dir = ensurePluginsDir()
  const safe = path.basename(fileName)
  if (!safe || safe === '.' || safe === '..') return false
  const full = path.join(dir, safe)
  if (!fs.existsSync(full)) return false
  const st = fs.statSync(full)
  if (st.isDirectory()) {
    rmrf(full)
    return true
  }
  if (st.isFile() && LEGACY_EXT.test(safe)) {
    fs.unlinkSync(full)
    return true
  }
  return false
}

export async function startPluginsHttpServer(): Promise<string> {
  if (server && baseUrl) return baseUrl
  if (listenPromise) return listenPromise

  const dir = ensurePluginsDir()
  listenPromise = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end('Method Not Allowed')
        return
      }

      const urlPath = req.url || '/'
      if (urlPath === '/' || urlPath.startsWith('/?')) {
        const list = listPluginsSync()
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(list))
        return
      }

      const filePath = safeResolveUnderPlugins(urlPath)
      if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-cache',
      })
      fs.createReadStream(filePath).pipe(res)
    })

    server.once('error', (err) => {
      listenPromise = null
      server = null
      reject(err)
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address()
      if (!addr || typeof addr === 'string') {
        listenPromise = null
        server?.close()
        server = null
        reject(new Error('Failed to bind plugins HTTP server'))
        return
      }
      baseUrl = `http://127.0.0.1:${addr.port}`
      console.log(`[plugins] serving ${dir} at ${baseUrl}`)
      resolve(baseUrl)
    })
  })

  return listenPromise
}

export function stopPluginsHttpServer() {
  if (server) {
    server.close()
    server = null
  }
  listenPromise = null
  baseUrl = ''
}

export async function bindPluginsIpc(getWindow: () => BrowserWindow | null) {
  await startPluginsHttpServer()

  ipcMain.handle('plugins:getBaseUrl', () => startPluginsHttpServer())
  ipcMain.handle('plugins:getDir', () => ensurePluginsDir())
  ipcMain.handle('plugins:list', async () => {
    await startPluginsHttpServer()
    return listPluginsSync()
  })
  ipcMain.handle('plugins:pickAndInstall', () => pickAndInstall(getWindow()))
  ipcMain.handle('plugins:remove', (_e, fileName: string) =>
    removePlugin(String(fileName || '')),
  )
  ipcMain.handle('plugins:revealDir', async () => {
    const { shell } = await import('electron')
    const dir = ensurePluginsDir()
    await shell.openPath(dir)
    return dir
  })
}
