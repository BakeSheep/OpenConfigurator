export const GAMEPAD_AXIS_FUNCTIONS = ['throttle', 'yaw', 'pitch', 'roll'] as const

export type GamepadAxisFunction = typeof GAMEPAD_AXIS_FUNCTIONS[number]
export type AxisFunctionMapping = Record<GamepadAxisFunction, number>

export function axisFunction(mapping: AxisFunctionMapping, axis: number): GamepadAxisFunction | null {
  return GAMEPAD_AXIS_FUNCTIONS.find((key) => mapping[key] === axis) ?? null
}

/** Assign a control function to a physical axis while preserving a bijection. */
export function remapAxisFunction(
  mapping: AxisFunctionMapping,
  axis: number,
  nextFunction: GamepadAxisFunction,
): Partial<AxisFunctionMapping> {
  const currentFunction = axisFunction(mapping, axis)
  if (currentFunction === nextFunction) return {}

  const previousAxis = mapping[nextFunction]
  return currentFunction
    ? { [nextFunction]: axis, [currentFunction]: previousAxis }
    : { [nextFunction]: axis }
}
