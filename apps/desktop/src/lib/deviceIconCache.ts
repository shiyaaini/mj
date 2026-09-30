/** Session-level product icon readiness — survives DeviceCard unmount/remount. */

type IconStatus = 'ready' | 'failed'

const statusByUrl = new Map<string, IconStatus>()
const inflight = new Map<string, Promise<boolean>>()

export function getCachedIconStatus(url: string | undefined | null): IconStatus | undefined {
  if (!url) return undefined
  return statusByUrl.get(url)
}

export function markIconReady(url: string) {
  statusByUrl.set(url, 'ready')
  inflight.delete(url)
}

export function markIconFailed(url: string) {
  statusByUrl.set(url, 'failed')
  inflight.delete(url)
}

/** Warm browser + session cache for a single icon URL. */
export function prefetchDeviceIcon(url: string): Promise<boolean> {
  const cached = statusByUrl.get(url)
  if (cached === 'ready') return Promise.resolve(true)
  if (cached === 'failed') return Promise.resolve(false)

  const existing = inflight.get(url)
  if (existing) return existing

  const promise = new Promise<boolean>((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      markIconReady(url)
      resolve(true)
    }
    img.onerror = () => {
      markIconFailed(url)
      resolve(false)
    }
    img.src = url
  })
  inflight.set(url, promise)
  return promise
}

/** Prefetch many icons with bounded concurrency (does not block UI). */
export async function prefetchDeviceIcons(
  urls: Array<string | undefined | null>,
  concurrency = 6,
): Promise<void> {
  const unique = [...new Set(urls.filter((u): u is string => Boolean(u)))]
  if (!unique.length) return

  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (index < unique.length) {
      const url = unique[index++]
      await prefetchDeviceIcon(url)
    }
  })
  await Promise.all(workers)
}
