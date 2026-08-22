import {
  availableModes,
  type FlightModeOption,
  type VehicleIdentity,
} from '../../shared/vehicleProfiles'

export const CORE_GAMEPAD_ACTION_IDS = [
  'none',
  'arm',
  'disarm',
  'toggle_arm',
] as const

export type CoreGamepadActionId = typeof CORE_GAMEPAD_ACTION_IDS[number]

// Version-1 settings stored cross-firmware semantic mode names. Keep these
// readable so existing users do not lose assignments, but new writes use a
// qualified mode action below.
const LEGACY_MODE_NAMES = {
  manual: { px4: 'Manual', arducopter: 'Stabilize' },
  altitude: { px4: 'Altitude', arducopter: 'AltHold' },
  position: { px4: 'Position', arducopter: 'PosHold' },
  mission: { px4: 'Mission', arducopter: 'Auto' },
  hold: { px4: 'Hold', arducopter: 'Loiter' },
  rtl: { px4: 'Return', arducopter: 'RTL' },
  land: { px4: 'Land', arducopter: 'Land' },
  stabilized: { px4: 'Stabilized', arducopter: 'Stabilize' },
  acro: { px4: 'Acro', arducopter: 'Acro' },
} as const

export type LegacyGamepadModeActionId = keyof typeof LEGACY_MODE_NAMES
export type QualifiedGamepadModeActionId =
  | `mode:px4:${number}`
  | `mode:ardupilot:copter:${number}`
export type GamepadActionId =
  | CoreGamepadActionId
  | LegacyGamepadModeActionId
  | QualifiedGamepadModeActionId

interface ParsedModeAction {
  profile: 'px4' | 'ardupilot:copter'
  modeId: number
}

const coreActions = new Set<string>(CORE_GAMEPAD_ACTION_IDS)
const legacyModeActions = new Set<string>(Object.keys(LEGACY_MODE_NAMES))

function parseQualifiedModeAction(value: string): ParsedModeAction | null {
  const match = /^(?:mode:)(px4|ardupilot:copter):(\d+)$/.exec(value)
  if (!match) return null
  const modeId = Number(match[2])
  if (!Number.isSafeInteger(modeId) || modeId < 0) return null
  return { profile: match[1] as ParsedModeAction['profile'], modeId }
}

export function isGamepadActionId(value: unknown): value is GamepadActionId {
  if (typeof value !== 'string') return false
  return coreActions.has(value) || legacyModeActions.has(value) || parseQualifiedModeAction(value) !== null
}

export function createModeGamepadAction(
  identity: VehicleIdentity | null,
  modeId: number,
): QualifiedGamepadModeActionId | null {
  if (!identity || !availableModes(identity).some((mode) => mode.id === modeId)) return null
  if (identity.family === 'px4') return `mode:px4:${modeId}`
  if (identity.family === 'ardupilot' && identity.vehicleClass === 'copter') {
    return `mode:ardupilot:copter:${modeId}`
  }
  return null
}

export function resolveGamepadModeAction(
  action: GamepadActionId,
  identity: VehicleIdentity | null,
): FlightModeOption | null {
  if (!identity) return null
  const modes = availableModes(identity)
  const qualified = parseQualifiedModeAction(action)
  if (qualified) {
    const profileMatches = qualified.profile === 'px4'
      ? identity.family === 'px4'
      : identity.family === 'ardupilot' && identity.vehicleClass === 'copter'
    if (!profileMatches) return null
    return modes.find((mode) => mode.id === qualified.modeId) ?? null
  }

  const legacyNames = LEGACY_MODE_NAMES[action as LegacyGamepadModeActionId]
  if (!legacyNames) return null
  const targetName = identity.family === 'px4'
    ? legacyNames.px4
    : identity.family === 'ardupilot' && identity.vehicleClass === 'copter'
      ? legacyNames.arducopter
      : null
  return targetName ? modes.find((mode) => mode.name === targetName) ?? null : null
}

export function normalizeGamepadActionForIdentity(
  action: GamepadActionId,
  identity: VehicleIdentity | null,
): GamepadActionId {
  const mode = resolveGamepadModeAction(action, identity)
  return mode ? createModeGamepadAction(identity, mode.id) ?? action : action
}

// QGC flight-mode and arm actions are edge-triggered. The hook still supports
// repeat-capable actions structurally for future camera/gimbal actions.
export function canRepeatGamepadAction(_action: GamepadActionId): boolean {
  return false
}
