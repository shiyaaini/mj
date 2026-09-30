import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'

// Last-resort: invalid HMR close frames must not take down `pnpm dev`.
process.on('uncaughtException', (err) => {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : ''
  if (code === 'WS_ERR_INVALID_CLOSE_CODE' || code.startsWith('WS_ERR_')) {
    console.warn(`[hmr] ignored uncaught ${code}`)
    return
  }
  console.error(err)
  process.exit(1)
})

/**
 * MITM proxies (Reqable) / Electron reconnects sometimes send invalid WS close
 * codes (1005/1006). Unhandled, that kills the Vite process.
 */
function hmrWsGuard(): Plugin {
  return {
    name: 'hmr-ws-guard',
    configureServer(server) {
      const attach = (socket: { on: (ev: string, fn: (...args: unknown[]) => void) => void }) => {
        socket.on('error', (err: unknown) => {
          const code =
            err && typeof err === 'object' && 'code' in err
              ? String((err as { code?: string }).code || '')
              : ''
          if (code === 'WS_ERR_INVALID_CLOSE_CODE' || code.startsWith('WS_ERR_')) {
            server.config.logger.warn(`[hmr] swallowed ${code}`)
            return
          }
          server.config.logger.warn(
            `[hmr] ws error: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }

      // Vite HotChannel / underlying ws server
      const ws = server.ws as unknown as {
        on?: (event: string, cb: (...args: unknown[]) => void) => void
      }
      ws.on?.('connection', (socket: unknown) => {
        if (socket && typeof socket === 'object') attach(socket as never)
      })

      server.httpServer?.on('upgrade', (_req, socket) => {
        socket.on('error', () => {
          /* ignore upgrade-socket noise from proxies */
        })
      })
    },
  }
}

export default defineConfig({
  // Relative base so /templates/* and other public assets resolve under file:// (Electron loadFile).
  base: './',
  plugins: [
    hmrWsGuard(),
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: 'electron/preload.ts',
      },
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  optimizeDeps: {
    include: ['sucrase'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Keep HMR on loopback so system MITM proxies are less likely to rewrite frames.
    hmr: {
      protocol: 'ws',
      host: '127.0.0.1',
      port: 5173,
      clientPort: 5173,
    },
  },
})
