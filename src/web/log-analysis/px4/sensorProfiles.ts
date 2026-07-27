// Semantic PX4 sensor field profiles.
//
// Chart extraction must select measurement fields by meaning — NEVER by
// `Object.keys(...).slice(0, 3)`. Field names come from the official
// message definitions:
// - SensorCombined: accelerometer_m_s2[3] (m/s²), gyro_rad[3] (rad/s),
//   accelerometer_clipping / gyro_clipping bitfields (bit0=X bit1=Y bit2=Z)
// - SensorAccel/SensorGyro/SensorMag: x/y/z scalars (older logs: xyz[3] /
//   magnetometer_ga[3])
// - SensorBaro: pressure (Pa), temperature (°C)
// - VehicleAirData: baro_pressure_pa, baro_alt_meter, baro_temp_celcius

export type SensorVectorKind = 'acceleration' | 'angularRate' | 'magneticField'
export type SensorScalarKind = 'pressure' | 'altitude' | 'temperature'

export interface ResolvedVector {
  kind: SensorVectorKind
  /** Exact field paths for the X/Y/Z axes, in order */
  fields: [string, string, string]
  unit: string
}

export interface ResolvedScalar {
  kind: SensorScalarKind
  field: string
  unit: string
}

interface VectorSpec {
  kind: SensorVectorKind
  /** Candidate field triplets in preference order */
  fieldSets: Array<[string, string, string]>
  unit: string
}

interface ScalarSpec {
  kind: SensorScalarKind
  /** Candidate fields in preference order */
  fields: string[]
  unit: string
}

export interface SensorTopicProfile {
  vectors: VectorSpec[]
  scalars: ScalarSpec[]
}

const XYZ: [string, string, string] = ['x', 'y', 'z']

export const SENSOR_PROFILES: Record<string, SensorTopicProfile> = {
  sensor_combined: {
    vectors: [
      {
        kind: 'acceleration',
        fieldSets: [['accelerometer_m_s2[0]', 'accelerometer_m_s2[1]', 'accelerometer_m_s2[2]']],
        unit: 'm/s²',
      },
      {
        kind: 'angularRate',
        fieldSets: [['gyro_rad[0]', 'gyro_rad[1]', 'gyro_rad[2]']],
        unit: 'rad/s',
      },
    ],
    scalars: [],
  },
  sensor_accel: {
    vectors: [
      {
        kind: 'acceleration',
        fieldSets: [XYZ, ['xyz[0]', 'xyz[1]', 'xyz[2]']],
        unit: 'm/s²',
      },
    ],
    scalars: [{ kind: 'temperature', fields: ['temperature'], unit: '°C' }],
  },
  sensor_gyro: {
    vectors: [
      {
        kind: 'angularRate',
        fieldSets: [XYZ, ['xyz[0]', 'xyz[1]', 'xyz[2]']],
        unit: 'rad/s',
      },
    ],
    scalars: [{ kind: 'temperature', fields: ['temperature'], unit: '°C' }],
  },
  sensor_mag: {
    vectors: [
      {
        kind: 'magneticField',
        fieldSets: [XYZ, ['magnetometer_ga[0]', 'magnetometer_ga[1]', 'magnetometer_ga[2]']],
        unit: 'Gs',
      },
    ],
    scalars: [{ kind: 'temperature', fields: ['temperature'], unit: '°C' }],
  },
  sensor_baro: {
    vectors: [],
    scalars: [
      { kind: 'pressure', fields: ['pressure'], unit: 'Pa' },
      { kind: 'temperature', fields: ['temperature'], unit: '°C' },
    ],
  },
  vehicle_air_data: {
    vectors: [],
    scalars: [
      { kind: 'pressure', fields: ['baro_pressure_pa'], unit: 'Pa' },
      { kind: 'altitude', fields: ['baro_alt_meter'], unit: 'm' },
      // PX4 spells this field "celcius"
      { kind: 'temperature', fields: ['baro_temp_celcius'], unit: '°C' },
    ],
  },
}

export const AXIS_LABELS: [string, string, string] = ['X', 'Y', 'Z']

/**
 * Resolve the semantic vector measurements available on a topic given the
 * fields actually present in the log. Returns only complete XYZ triplets.
 */
export function resolveVectors(
  topicName: string,
  availableFields: ReadonlySet<string>,
): ResolvedVector[] {
  const profile = SENSOR_PROFILES[topicName]
  if (!profile) return []
  const resolved: ResolvedVector[] = []
  for (const vector of profile.vectors) {
    for (const fieldSet of vector.fieldSets) {
      if (fieldSet.every((f) => availableFields.has(f))) {
        resolved.push({ kind: vector.kind, fields: fieldSet, unit: vector.unit })
        break
      }
    }
  }
  return resolved
}

/** Resolve the semantic scalar measurements available on a topic. */
export function resolveScalars(
  topicName: string,
  availableFields: ReadonlySet<string>,
): ResolvedScalar[] {
  const profile = SENSOR_PROFILES[topicName]
  if (!profile) return []
  const resolved: ResolvedScalar[] = []
  for (const scalar of profile.scalars) {
    const field = scalar.fields.find((f) => availableFields.has(f))
    if (field) resolved.push({ kind: scalar.kind, field, unit: scalar.unit })
  }
  return resolved
}

/** Chinese display names for vector kinds. */
export const VECTOR_KIND_LABELS: Record<SensorVectorKind, string> = {
  acceleration: '加速度',
  angularRate: '角速度',
  magneticField: '磁场',
}

/** Chinese display names for scalar kinds. */
export const SCALAR_KIND_LABELS: Record<SensorScalarKind, string> = {
  pressure: '气压',
  altitude: '气压高度',
  temperature: '温度',
}

/**
 * Decode the SensorCombined clipping bitfields: bit0=X, bit1=Y, bit2=Z.
 * Returns per-axis booleans for one sample.
 */
export function decodeClippingBits(bits: number): [boolean, boolean, boolean] {
  return [(bits & 1) !== 0, (bits & 2) !== 0, (bits & 4) !== 0]
}
