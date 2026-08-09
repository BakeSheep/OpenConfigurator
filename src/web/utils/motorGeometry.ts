export interface RotorPositionInput {
  px: number | undefined
  py: number | undefined
}

/**
 * PX4 rotor geometry is authoritative only as a complete set. Mixing a
 * partial CA_ROTOR* set with inferred positions creates a misleading frame.
 */
export function hasCompleteRotorGeometry(positions: readonly RotorPositionInput[]): boolean {
  return positions.length > 0
    && positions.every(({ px, py }) => Number.isFinite(px) && Number.isFinite(py))
}
