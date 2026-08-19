import { Navigate, useSearchParams } from 'react-router-dom'

/** Compatibility boundary for legacy diagnostics links. */
export default function DiagnosticsPage() {
  const [params] = useSearchParams()
  const target: Record<string, string> = {
    parameters: '/tuning', pid: '/tuning/pid', waveforms: '/flight-data/waveforms',
    messages: '/flight-data', logs: '/flight-logs', 'log-analysis': '/flight-logs/analysis', ekf: '/tuning/ekf',
  }
  return <Navigate replace to={target[params.get('section') ?? ''] ?? '/tuning'} />
}
