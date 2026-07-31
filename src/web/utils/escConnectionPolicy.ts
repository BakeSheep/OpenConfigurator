import type { VehicleIdentity } from '../../shared/types'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'

export type EscConnectionMode = 'ardupilot_passthrough' | 'px4_serial_control' | 'direct'

interface OperationErrorLike {
  operation: string
  requestId?: string
  message: string
}

/**
 * Flight-controller passthrough is a write operation and therefore follows
 * the selected HEARTBEAT profile. Direct 19200-baud serial does not mutate a
 * selected flight controller, so its transport checks remain independent.
 */
export function escModeAllowedForProfile(
  identity: VehicleIdentity | null,
  mode: EscConnectionMode,
): boolean {
  if (mode === 'direct') return true
  if (!vehicleCapabilities(identity).writeOperations) return false
  return mode === 'ardupilot_passthrough'
    ? identity?.family === 'ardupilot'
    : identity?.family === 'px4'
}

/** Match only the boundary rejection belonging to the active setup write. */
export function passthroughParamWriteError(
  pendingRequestId: string | null,
  error: OperationErrorLike | null,
): string | null {
  if (
    pendingRequestId === null
    || error?.operation !== 'param_set'
    || error.requestId !== pendingRequestId
  ) return null
  return error.message
}
