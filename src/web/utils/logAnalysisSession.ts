// Hand-off Blob between the flight-log explorer and the analysis page.
// A module-level stash (not zustand) because the log can be large,
// single-consumer and must not be retained after the analysis page takes it.

export interface StashedLog {
  name: string
  sourcePath?: string
  blob: Blob
}

let stashed: StashedLog | null = null

export function stashLogBlob(name: string, blob: Blob, sourcePath?: string): void {
  stashed = { name, blob, sourcePath }
}

export function takeStashedLog(): StashedLog | null {
  const result = stashed
  stashed = null
  return result
}
