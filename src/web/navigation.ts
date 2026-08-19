import type { IconName } from './components/ui/Icon'

export interface NavigationItem {
  id: string
  labelKey: string
  icon: IconName
  path: string
}

export interface NavigationDomain {
  id: string
  labelKey: string
  icon: IconName
  defaultPath: string
  items: NavigationItem[]
}

export const navigationDomains: NavigationDomain[] = [
  { id: 'overview', labelKey: 'sidebar.overview', icon: 'dashboard', defaultPath: '/dashboard', items: [{ id: 'dashboard', labelKey: 'domain.overview.dashboard', icon: 'dashboard', path: '/dashboard' }] },
  { id: 'flight', labelKey: 'sidebar.flight', icon: 'flight', defaultPath: '/flight', items: [{ id: 'flight', labelKey: 'domain.flight.flight', icon: 'flight', path: '/flight' }] },
  { id: 'airframe', labelKey: 'sidebar.airframe', icon: 'flight', defaultPath: '/airframe', items: [
    { id: 'airframe', labelKey: 'settings.section.airframe.label', icon: 'flight', path: '/airframe' },
    { id: 'sensors', labelKey: 'settings.section.sensors.label', icon: 'sensor', path: '/airframe/sensors' },
    { id: 'power', labelKey: 'domain.airframe.power', icon: 'battery', path: '/airframe/power' },
    { id: 'safety', labelKey: 'domain.airframe.safety', icon: 'hardware', path: '/airframe/safety' },
  ] },
  { id: 'propulsion', labelKey: 'sidebar.propulsion', icon: 'actuator', defaultPath: '/propulsion', items: [
    { id: 'mapping', labelKey: 'motor.tabMapping', icon: 'actuator', path: '/propulsion' },
    { id: 'motor-test', labelKey: 'motor.tabTest', icon: 'motor', path: '/propulsion/test?tab=test' },
    { id: 'esc', labelKey: 'settings.section.esc.label', icon: 'firmware', path: '/propulsion/esc' },
  ] },
  { id: 'control-input', labelKey: 'sidebar.controlInput', icon: 'receiver', defaultPath: '/control-input', items: [
    { id: 'receiver', labelKey: 'settings.section.receiver.label', icon: 'receiver', path: '/control-input' },
    { id: 'joystick', labelKey: 'settings.section.joystick.label', icon: 'gamepad', path: '/control-input/joystick' },
    { id: 'flight-modes', labelKey: 'domain.controlInput.flightModes', icon: 'flight', path: '/control-input/flight-modes' },
  ] },
  { id: 'tuning', labelKey: 'sidebar.tuning', icon: 'tune', defaultPath: '/tuning', items: [
    { id: 'parameters', labelKey: 'diagnostics.section.parameters.label', icon: 'parameters', path: '/tuning' },
    { id: 'pid', labelKey: 'diagnostics.section.pid.label', icon: 'tune', path: '/tuning/pid' },
    { id: 'ekf', labelKey: 'domain.tuning.ekf', icon: 'route', path: '/tuning/ekf' },
  ] },
  { id: 'flight-data', labelKey: 'sidebar.flightData', icon: 'waveform', defaultPath: '/flight-data', items: [
    { id: 'messages', labelKey: 'diagnostics.section.messages.label', icon: 'message', path: '/flight-data' },
    { id: 'message-status', labelKey: 'domain.flightData.status', icon: 'waveform', path: '/flight-data/status?tab=status' },
    { id: 'message-terminal', labelKey: 'domain.flightData.terminal', icon: 'plug', path: '/flight-data/terminal?tab=terminal' },
    { id: 'waveforms', labelKey: 'diagnostics.section.waveforms.label', icon: 'waveform', path: '/flight-data/waveforms' },
  ] },
  { id: 'flight-logs', labelKey: 'sidebar.flightLogs', icon: 'folder', defaultPath: '/flight-logs', items: [
    { id: 'logs', labelKey: 'diagnostics.section.logs.label', icon: 'folder', path: '/flight-logs' },
    { id: 'log-analysis', labelKey: 'diagnostics.section.log-analysis.label', icon: 'log', path: '/flight-logs/analysis' },
  ] },
]

export const domainById = (id: string) => navigationDomains.find((domain) => domain.id === id)
