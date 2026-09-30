import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const HEALTH_TIMEOUT_MS = 2500
const READY_TIMEOUT_MS = 25_000
const POLL_INTERVAL_MS = 400
const MAX_BACKOFF_MS = 30_000
const MAX_RESTARTS = 12

type BridgeSupervisorState = {
  child: ChildProcess | null
  owned: boolean
  shuttingDown: boolean
  restartCount: number
  restartTimer: ReturnType<typeof setTimeout> | null
  host: string
  port: number
  bridgeRoot: string
  mode: 'frozen' | 'uv' | 'none'
}

const state: BridgeSupervisorState = {
  child: null,
  owned: false,
  shuttingDown: false,
  restartCount: 0,
  restartTimer: null,
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  bridgeRoot: '',
  mode: 'none',
}

function log(...args: unknown[]) {
  console.log('[bridge]', ...args)
}

function logErr(...args: unknown[]) {
  console.error('[bridge]', ...args)
}

function resolveBridgeRoot(): string {
  if (process.env.MI_HOME_BRIDGE_ROOT) {
    return path.resolve(process.env.MI_HOME_BRIDGE_ROOT)
  }
  const appRoot = process.env.APP_ROOT || path.join(moduleDir, '..')
  // apps/desktop → apps/bridge
  return path.resolve(appRoot, '..', 'bridge')
}

/** Packaged layout: resources/bridge/mi-home-bridge.exe (+ _internal). */
function resolveFrozenBridge(): { exe: string; cwd: string } | null {
  if (!app.isPackaged) return null
  const exeName = process.platform === 'win32' ? 'mi-home-bridge.exe' : 'mi-home-bridge'
  const roots = [
    path.join(process.resourcesPath, 'bridge'),
    path.join(process.resourcesPath, 'bridge', 'mi-home-bridge'),
  ]
  for (const dir of roots) {
    const exe = path.join(dir, exeName)
    if (fs.existsSync(exe)) return { exe, cwd: dir }
  }
  return null
}

function resolveDataDir(frozenCwd?: string): string {
  if (process.env.MI_HOME_DATA_DIR) return process.env.MI_HOME_DATA_DIR
  // Packaged: use bundled data next to frozen exe (includes product icons).
  if (frozenCwd && app.isPackaged) {
    return path.join(frozenCwd, 'data')
  }
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'bridge-data')
  }
  if (frozenCwd) return path.join(frozenCwd, 'data')
  return path.join(resolveBridgeRoot(), 'data')
}

function resolveHostPort(): { host: string; port: number } {
  const host = process.env.MI_HOME_HOST || DEFAULT_HOST
  const raw =
    process.env.MI_HOME_PORT ||
    process.env.VITE_BRIDGE_URL?.match(/:(\d+)/)?.[1] ||
    String(DEFAULT_PORT)
  const port = Number(raw)
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
  }
}

function bridgeChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'FTP_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'ftp_proxy',
  ]) {
    delete env[key]
  }
  const noProxy = [
    '127.0.0.1',
    'localhost',
    '::1',
    'api.mijia.tech',
    '*.mijia.tech',
    '*.mi.com',
    env.NO_PROXY,
    env.no_proxy,
  ]
    .filter(Boolean)
    .join(',')
  env.NO_PROXY = noProxy
  env.no_proxy = noProxy
  return env
}

function skipAutoStart(): boolean {
  const v = (process.env.MI_HOME_SKIP_BRIDGE || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export function probeBridgeHealth(
  host = state.host,
  port = state.port,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port,
        path: '/health',
        timeout: timeoutMs,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(false)
            return
          }
          try {
            const json = JSON.parse(body) as { status?: string }
            resolve(json.status === 'ok')
          } catch {
            resolve(false)
          }
        })
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitUntilHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeBridgeHealth()) return true
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return probeBridgeHealth()
}

function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'taskkill',
        ['/pid', String(pid), '/T', '/F'],
        { windowsHide: true },
        () => resolve(),
      )
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      resolve()
      return
    }
    const t = setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }, 2500)
    const check = setInterval(() => {
      try {
        process.kill(pid, 0)
      } catch {
        clearInterval(check)
        clearTimeout(t)
        resolve()
      }
    }, 200)
  })
}

function pipeChildLogs(child: ChildProcess) {
  const forward = (chunk: Buffer | string, isErr: boolean) => {
    const text = String(chunk).replace(/\r?\n$/, '')
    if (!text) return
    for (const line of text.split(/\r?\n/)) {
      if (isErr) logErr(line)
      else log(line)
    }
  }
  child.stdout?.on('data', (c) => forward(c, false))
  child.stderr?.on('data', (c) => forward(c, true))
}

function scheduleRestart() {
  if (state.shuttingDown || !state.owned) return
  if (state.restartCount >= MAX_RESTARTS) {
    logErr(`gave up after ${MAX_RESTARTS} restart attempts`)
    return
  }
  const delay = Math.min(
    1000 * 2 ** Math.min(state.restartCount, 5),
    MAX_BACKOFF_MS,
  )
  state.restartCount += 1
  log(`restarting in ${delay}ms (attempt ${state.restartCount}/${MAX_RESTARTS})`)
  if (state.restartTimer) clearTimeout(state.restartTimer)
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null
    void spawnOwnedBridge()
  }, delay)
}

function spawnOwnedBridge(): Promise<boolean> {
  if (state.shuttingDown) return Promise.resolve(false)

  if (state.child && !state.child.killed) {
    return waitUntilHealthy(READY_TIMEOUT_MS)
  }

  const frozen = resolveFrozenBridge()
  let child: ChildProcess

  if (frozen) {
    state.mode = 'frozen'
    state.bridgeRoot = frozen.cwd
    const dataDir = resolveDataDir(frozen.cwd)
    fs.mkdirSync(dataDir, { recursive: true })
    log(`spawn frozen: ${frozen.exe} (cwd=${frozen.cwd}, data=${dataDir})`)
    try {
      child = spawn(frozen.exe, [], {
        cwd: frozen.cwd,
        env: bridgeChildEnv({
          MI_HOME_HOST: state.host,
          MI_HOME_PORT: String(state.port),
          MI_HOME_DATA_DIR: dataDir,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (err) {
      logErr('failed to spawn frozen bridge', err)
      scheduleRestart()
      return Promise.resolve(false)
    }
  } else {
    state.mode = 'uv'
    state.bridgeRoot = resolveBridgeRoot()
    if (!fs.existsSync(path.join(state.bridgeRoot, 'main.py'))) {
      logErr(`bridge root missing main.py: ${state.bridgeRoot}`)
      return Promise.resolve(false)
    }

    const args = [
      'run',
      'uvicorn',
      'main:app',
      '--host',
      state.host,
      '--port',
      String(state.port),
    ]
    const uv = resolveUvBin()
    log(`spawn: ${uv} ${args.join(' ')} (cwd=${state.bridgeRoot})`)
    try {
      child = spawn(uv, args, {
        cwd: state.bridgeRoot,
        env: bridgeChildEnv({
          MI_HOME_HOST: state.host,
          MI_HOME_PORT: String(state.port),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (err) {
      logErr('failed to spawn uv', err)
      scheduleRestart()
      return Promise.resolve(false)
    }
  }

  state.child = child
  state.owned = true
  pipeChildLogs(child)

  child.on('error', (err) => {
    logErr('child error', err.message)
  })

  child.on('exit', (code, signal) => {
    log(`exited code=${code} signal=${signal}`)
    state.child = null
    if (state.shuttingDown) return
    if (state.owned) scheduleRestart()
  })

  return waitUntilHealthy(READY_TIMEOUT_MS).then((ok) => {
    if (ok) {
      state.restartCount = 0
      log(`ready at http://${state.host}:${state.port} (${state.mode})`)
    } else {
      logErr(`not healthy within ${READY_TIMEOUT_MS}ms`)
    }
    return ok
  })
}

function resolveUvBin(): string {
  if (process.env.MI_HOME_UV) return process.env.MI_HOME_UV
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', ['uv'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      const first = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && !s.toLowerCase().endsWith('.cmd') && !s.toLowerCase().endsWith('.bat'))
      if (first) return first
      const cmd = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean)
      if (cmd) return cmd
    } else {
      const out = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim()
      if (out) return out
    }
  } catch {
    /* fall through */
  }
  return process.platform === 'win32' ? 'uv.exe' : 'uv'
}

/**
 * Adopt an already-running Bridge, or spawn + supervise one under Electron.
 * Safe to call once at app ready. Returns when healthy, external adopted, or timed out.
 */
export async function startBridgeSupervisor(): Promise<{
  ok: boolean
  owned: boolean
  skipped?: boolean
}> {
  state.shuttingDown = false
  const { host, port } = resolveHostPort()
  state.host = host
  state.port = port
  state.bridgeRoot = resolveBridgeRoot()

  if (skipAutoStart()) {
    log('skipped (MI_HOME_SKIP_BRIDGE)')
    return { ok: await probeBridgeHealth(), owned: false, skipped: true }
  }

  if (await probeBridgeHealth()) {
    log(`adopted existing server at http://${host}:${port}`)
    state.owned = false
    state.mode = 'none'
    return { ok: true, owned: false }
  }

  const ok = await spawnOwnedBridge()
  return { ok, owned: state.owned }
}

export async function stopBridgeSupervisor(): Promise<void> {
  state.shuttingDown = true
  state.owned = false
  if (state.restartTimer) {
    clearTimeout(state.restartTimer)
    state.restartTimer = null
  }

  const child = state.child
  state.child = null
  if (!child?.pid) return

  log(`stopping pid=${child.pid}`)
  await killProcessTree(child.pid)
  log('stopped')
}

export function getBridgeSupervisorInfo() {
  return {
    host: state.host,
    port: state.port,
    owned: state.owned,
    pid: state.child?.pid ?? null,
    bridgeRoot: state.bridgeRoot,
    mode: state.mode,
  }
}
