import { PX4_AIRFRAMES, type Px4AirframeCatalogEntry } from './generated/px4Airframes'

export { PX4_AIRFRAMES }
export type { Px4AirframeCatalogEntry }

export function getPx4AirframeInfo(value: number | undefined): Px4AirframeCatalogEntry | null {
  if (!Number.isFinite(value) || !value) return null
  return PX4_AIRFRAMES.find((airframe) => airframe.autostartId === Math.round(value!)) ?? null
}

export interface ArduCopterFrameOption {
  frameClass: number
  frameClassName: string
  frameType: number
  frameTypeName: string
}

export const ARDUCOPTER_FRAME_CLASSES: Readonly<Record<number, string>> = {
  1: 'Quad',
  2: 'Hexa',
  3: 'Octa',
  4: 'OctaQuad',
  5: 'Y6',
  7: 'Tri',
  9: 'SingleCopter',
  10: 'CoaxCopter',
  11: 'BiCopter',
  12: 'DodecaHexa',
  14: 'Deca',
}

export const ARDUCOPTER_FRAME_TYPES: Readonly<Record<number, string>> = {
  0: 'Plus',
  1: 'X',
  2: 'V',
  3: 'H',
  4: 'V-Tail',
  5: 'A-Tail',
  10: 'Y6B',
  11: 'Y6F',
  12: 'BetaFlight X',
  13: 'DJI X',
  14: 'Clockwise X',
  18: 'BetaFlight X Reversed',
}

// Matches the combinations exposed by QGC's ArduCopter frame picker. Heli
// classes are intentionally absent: their setup is a separate workflow.
const ARDUCOPTER_TYPES_BY_CLASS: Readonly<Record<number, readonly number[]>> = {
  1: [0, 1, 2, 3, 4, 5, 12, 13, 14, 18],
  2: [0, 1],
  3: [0, 1, 2, 3],
  4: [0, 1, 2, 3],
  5: [1, 10, 11],
  7: [0, 1],
  9: [0],
  10: [0],
  11: [0],
  12: [0, 1],
  14: [0, 1],
}

export const ARDUCOPTER_FRAME_OPTIONS: readonly ArduCopterFrameOption[] = Object.entries(ARDUCOPTER_TYPES_BY_CLASS)
  .flatMap(([frameClass, types]) => types.map((frameType) => ({
    frameClass: Number(frameClass),
    frameClassName: ARDUCOPTER_FRAME_CLASSES[Number(frameClass)],
    frameType,
    frameTypeName: ARDUCOPTER_FRAME_TYPES[frameType],
  })))

export function isSupportedArduCopterFrame(frameClass: number, frameType: number): boolean {
  return ARDUCOPTER_FRAME_OPTIONS.some((option) => option.frameClass === frameClass && option.frameType === frameType)
}
