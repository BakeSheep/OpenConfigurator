import type { VehicleIdentity } from '../../shared/types'
import arducopterCatalogJson from '../data/parameterEnums/arducopter.json'
import px4CatalogJson from '../data/parameterEnums/px4.json'

export interface ParameterEnumOption {
  value: number
  label: string
}

interface ParameterEnumCatalog {
  source: string
  sets: Array<Array<[number, string]>>
  parameters: Record<string, number>
}

const PX4_CATALOG = px4CatalogJson as unknown as ParameterEnumCatalog
const ARDUCOPTER_CATALOG = arducopterCatalogJson as unknown as ParameterEnumCatalog

// QGC/PX4 main no longer carries some legacy parameters. Keep well-defined
// historical enums so older supported flight controllers still get the same
// editor instead of falling back to an opaque number field.
const LEGACY_PX4_ENUMS: Record<string, ParameterEnumOption[]> = {
  BATMON_DRIVER_EN: [
    { value: 0, label: 'Disabled' },
    { value: 1, label: 'Start on default I2C addr (BATMON_ADDR_DFLT)' },
    { value: 2, label: 'Autodetect I2C address (TODO)' },
  ],
}

function catalogOptions(catalog: ParameterEnumCatalog, id: string): ParameterEnumOption[] | null {
  const setIndex = catalog.parameters[id]
  if (setIndex === undefined) return null
  const set = catalog.sets[setIndex]
  if (!set?.length) return null
  return set.map(([value, label]) => ({ value, label }))
}

/**
 * Return firmware-scoped enum metadata for a parameter. Unknown stacks and
 * non-Copter ArduPilot classes never borrow another firmware's value meanings.
 * Bitmasks are intentionally absent from the generated catalogs.
 */
export function parameterEnumOptions(
  id: string,
  identity: VehicleIdentity | null,
): ParameterEnumOption[] | null {
  if (identity?.family === 'px4') {
    return catalogOptions(PX4_CATALOG, id) ?? LEGACY_PX4_ENUMS[id] ?? null
  }
  if (identity?.family === 'ardupilot' && identity.vehicleClass === 'copter') {
    return catalogOptions(ARDUCOPTER_CATALOG, id)
  }
  return null
}

export function parameterEnumValuesMatch(left: number, right: number): boolean {
  if (left === right) return true
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= scale * 1e-6
}

export function parameterEnumLabel(
  id: string,
  value: number,
  identity: VehicleIdentity | null,
): string | null {
  return parameterEnumOptions(id, identity)
    ?.find((option) => parameterEnumValuesMatch(option.value, value))?.label ?? null
}
