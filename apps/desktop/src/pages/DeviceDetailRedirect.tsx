import { useLayoutEffect } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useAppStore } from '@/stores/appStore'

/** Legacy `/devices/:id` URLs → open modal on devices list */
export function DeviceDetailRedirect() {
  const { id } = useParams()
  const openDeviceDetail = useAppStore((s) => s.openDeviceDetail)

  useLayoutEffect(() => {
    if (id) openDeviceDetail(id)
  }, [id, openDeviceDetail])

  return <Navigate to="/devices" replace />
}
