import type { ParamData, VehicleIdentity } from '../../shared/types'
import { isSensitiveParameter } from '../../shared/parameterSafety'

const INTEGER_PARAM_RANGES: Readonly<Record<number, readonly [number, number]>> = {
  1: [0, 0xff],
  2: [-0x80, 0x7f],
  3: [0, 0xffff],
  4: [-0x8000, 0x7fff],
  5: [0, 0xffffffff],
  6: [-0x80000000, 0x7fffffff],
  7: [0, Number.MAX_SAFE_INTEGER],
  8: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}

export interface QgcParameterRow {
  line: number
  systemId: number
  componentId: number
  name: string
  value: number
  type: number
}

export type QgcParameterParseIssueReason =
  | 'column_count'
  | 'invalid_system_id'
  | 'invalid_component_id'
  | 'invalid_name'
  | 'invalid_value'
  | 'invalid_type'
  | 'duplicate_parameter'

export interface QgcParameterParseIssue {
  line: number
  raw: string
  reason: QgcParameterParseIssueReason
}

export interface QgcParameterParseResult {
  rows: QgcParameterRow[]
  issues: QgcParameterParseIssue[]
}

export type QgcParameterPreviewStatus =
  | 'write'
  | 'unchanged'
  | 'target_mismatch'
  | 'missing'
  | 'type_mismatch'
  | 'invalid_value'

export interface QgcParameterPreviewEntry {
  row: QgcParameterRow
  status: QgcParameterPreviewStatus
  current?: ParamData
  dangerous: boolean
}

export interface QgcParameterPreview {
  entries: QgcParameterPreviewEntry[]
  writable: QgcParameterPreviewEntry[]
  issues: QgcParameterParseIssue[]
  dangerousCount: number
}

export interface QgcParameterSerializationOptions {
  systemId: number
  componentId: number
  params: Iterable<ParamData>
  identity?: VehicleIdentity | null
  firmwareVersion?: string | null
}

export function validateMavParamValue(value: number, type: number): boolean {
  if (!Number.isFinite(value)) return false
  if (type === 9) return Number.isFinite(Math.fround(value))
  if (type === 10) return true
  const range = INTEGER_PARAM_RANGES[type]
  return range !== undefined
    && Number.isSafeInteger(value)
    && value >= range[0]
    && value <= range[1]
}

export function mavParamValuesMatch(left: number, right: number, type: number): boolean {
  return type === 9 ? Math.fround(left) === Math.fround(right) : left === right
}

export function isDangerousParameter(name: string): boolean {
  return isSensitiveParameter(name)
}

export function parseQgcParameterFile(content: string): QgcParameterParseResult {
  const rows: QgcParameterRow[] = []
  const issues: QgcParameterParseIssue[] = []
  const seen = new Set<string>()

  for (const [index, sourceLine] of content.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const raw = sourceLine.trim()
    if (raw === '' || raw.startsWith('#')) continue
    const fields = raw.split(/[\t ,]+/)
    const issue = (reason: QgcParameterParseIssueReason) => {
      issues.push({ line: index + 1, raw: sourceLine, reason })
    }
    if (fields.length !== 5) {
      issue('column_count')
      continue
    }

    const systemId = Number(fields[0])
    const componentId = Number(fields[1])
    const name = fields[2] ?? ''
    const value = Number(fields[3])
    const type = Number(fields[4])
    if (!Number.isInteger(systemId) || systemId < 1 || systemId > 255) {
      issue('invalid_system_id')
      continue
    }
    if (!Number.isInteger(componentId) || componentId < 0 || componentId > 255) {
      issue('invalid_component_id')
      continue
    }
    if (!/^[\x21-\x7e]{1,16}$/.test(name)) {
      issue('invalid_name')
      continue
    }
    if (!Number.isFinite(value)) {
      issue('invalid_value')
      continue
    }
    if (!Number.isInteger(type) || type < 1 || type > 10) {
      issue('invalid_type')
      continue
    }
    const key = `${systemId}:${componentId}:${name}`
    if (seen.has(key)) {
      issue('duplicate_parameter')
      continue
    }
    seen.add(key)
    rows.push({ line: index + 1, systemId, componentId, name, value, type })
  }

  return { rows, issues }
}

export function buildQgcParameterPreview(
  parsed: QgcParameterParseResult,
  currentParams: ReadonlyMap<string, ParamData>,
  systemId: number,
  componentId: number,
): QgcParameterPreview {
  const entries = parsed.rows.map<QgcParameterPreviewEntry>((row) => {
    const dangerous = isDangerousParameter(row.name)
    if (row.systemId !== systemId || row.componentId !== componentId) {
      return { row, status: 'target_mismatch', dangerous }
    }
    const current = currentParams.get(row.name)
    if (!current) return { row, status: 'missing', dangerous }
    if (current.type !== row.type) return { row, current, status: 'type_mismatch', dangerous }
    if (!validateMavParamValue(row.value, row.type)) {
      return { row, current, status: 'invalid_value', dangerous }
    }
    return {
      row,
      current,
      status: mavParamValuesMatch(current.value, row.value, row.type) ? 'unchanged' : 'write',
      dangerous,
    }
  })
  const writable = entries.filter((entry) => entry.status === 'write')
  return {
    entries,
    writable,
    issues: parsed.issues,
    dangerousCount: writable.filter((entry) => entry.dangerous).length,
  }
}

function qgcStackLabel(identity?: VehicleIdentity | null): string {
  if (identity?.family === 'px4') return 'PX4'
  if (identity?.family === 'ardupilot') return 'ArduPilot'
  return 'Generic'
}

function qgcVehicleLabel(identity?: VehicleIdentity | null): string {
  switch (identity?.vehicleClass) {
    case 'copter': return 'Multi-Rotor'
    case 'plane': return 'Fixed-Wing'
    case 'rover': return 'Rover-Boat'
    case 'sub': return 'Sub'
    case 'tracker': return 'Antenna-Tracker'
    default: return 'Generic'
  }
}

export function serializeQgcParameterFile(options: QgcParameterSerializationOptions): string {
  const lines = [
    `# Onboard parameters for Vehicle ${options.systemId}`,
    '#',
    `# Stack: ${qgcStackLabel(options.identity)}`,
    `# Vehicle: ${qgcVehicleLabel(options.identity)}`,
  ]
  if (options.firmwareVersion) lines.push(`# Version: ${options.firmwareVersion}`)
  lines.push('#', '# Vehicle-Id Component-Id Name Value Type')

  const params = Array.from(options.params).sort((left, right) => left.id.localeCompare(right.id))
  for (const param of params) {
    lines.push([
      options.systemId,
      options.componentId,
      param.id,
      String(param.value),
      param.type,
    ].join('\t'))
  }
  return `${lines.join('\n')}\n`
}
