// Hand-off buffer between the flight-log explorer and the analysis page.
// A module-level stash (not zustand) because the ArrayBuffer is large,
// single-consumer and must not be retained after the analysis page takes it.

export interface StashedLog {
  name: string
  sourcePath?: string
  buffer: ArrayBuffer
}

let stashed: StashedLog | null = null

export function stashLogBuffer(name: string, buffer: ArrayBuffer, sourcePath?: string): void {
  stashed = { name, buffer, sourcePath }
}

export function takeStashedLog(): StashedLog | null {
  const result = stashed
  stashed = null
  return result
}
