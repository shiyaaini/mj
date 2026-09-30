import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/appStore'

/** Wait until zustand persist has rehydrated from localStorage. */
export function useAppStoreHydrated() {
  const [hydrated, setHydrated] = useState(() => useAppStore.persist.hasHydrated())

  useEffect(() => {
    setHydrated(useAppStore.persist.hasHydrated())
    return useAppStore.persist.onFinishHydration(() => setHydrated(true))
  }, [])

  return hydrated
}
