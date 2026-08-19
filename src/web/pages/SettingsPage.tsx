import { Navigate, useSearchParams } from 'react-router-dom'

/** Compatibility boundary for bookmarks created before business-domain navigation. */
export default function SettingsPage() {
  const [params] = useSearchParams()
  const target: Record<string, string> = {
    sensors: '/airframe/sensors', actuators: '/propulsion', esc: '/propulsion/esc',
    receiver: '/control-input', joystick: '/control-input/joystick', other: '/tuning/ekf',
    airframe: '/airframe', power: '/airframe/power', safety: '/airframe/safety',
  }
  return <Navigate replace to={target[params.get('section') ?? ''] ?? '/airframe'} />
}
