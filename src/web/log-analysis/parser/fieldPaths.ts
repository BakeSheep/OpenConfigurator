/**
 * Utility functions for resolving ULog field paths from format definitions.
 */

const NUMERIC_TYPES = new Set([
  'uint8_t',
  'int8_t',
  'uint16_t',
  'int16_t',
  'uint32_t',
  'int32_t',
  'uint64_t',
  'int64_t',
  'float',
  'double',
])

/**
 * Extract the base type from a type string.
 * @example baseType("float[3]") → "float"
 * @example baseType("uint64_t") → "uint64_t"
 */
export function baseType(type: string): string {
  const match = /\[/.exec(type)
  return match ? type.slice(0, match.index) : type
}

/**
 * Extract array length from a type string.
 * @example arrayLength("float[3]") → 3
 * @example arrayLength("uint64_t") → null
 */
export function arrayLength(type: string): number | null {
  const match = /\[(\d+)\]/.exec(type)
  return match ? parseInt(match[1]!, 10) : null
}

/**
 * Check if a field type is numeric (plottable).
 * uint8_t through double are plottable. char, char[], bool are not.
 * Array of numeric types is plottable (each element).
 */
export function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.has(baseType(type))
}

/**
 * Expand a ULog field definition into leaf paths.
 *
 * Scalar:  ("float", "speed")         → ["speed"]
 * Array:   ("float[3]", "accel")      → ["accel[0]", "accel[1]", "accel[2]"]
 * Struct:  ("MyStruct", "nested", …)  → ["nested.x", "nested.y"]  (recursive)
 *
 * @param type      The field type string, e.g. "float[3]" or "MyStruct"
 * @param name      The field name
 * @param structDefs  Optional map of struct name → field definitions for nested expansion
 */
export function expandFieldPaths(
  type: string,
  name: string,
  structDefs?: Map<string, Array<{ type: string; name: string }>>,
): string[] {
  const len = arrayLength(type)
  const base = baseType(type)

  // Nested struct expansion
  if (structDefs?.has(base) && len === null) {
    const fields = structDefs.get(base)!
    return fields.flatMap((f) =>
      expandFieldPaths(f.type, `${name}.${f.name}`, structDefs),
    )
  }

  // Array expansion
  if (len !== null) {
    return Array.from({ length: len }, (_, i) => `${name}[${i}]`)
  }

  // Scalar
  return [name]
}
