// Unit-safe, real-time magnetic-interference advisory.
//
// Inputs are ALWAYS the latest field magnitude in Gauss. Callers convert
// mGauss components with magFieldFromMilliGauss(); RAW_IMU counts must never
// be fed here because they are not convertible to Gauss.
//
// The displayed magnitude is never averaged. Only the good/high classification
// is stabilized: a new state must persist for a short debounce interval, and a
// small hysteresis band prevents a value on the threshold from toggling the UI.
// This remains advisory and never blocks calibration on the server.

/** Healthy total field magnitude band (Gauss). Earth's field is ~0.25-0.65 G. */
export const MAG_FIELD_MIN_GAUSS = 0.25
export const MAG_FIELD_MAX_GAUSS = 0.65
/** A warning only clears after returning this far inside the healthy band. */
export const MAG_FIELD_HYSTERESIS_GAUSS = 0.02
/** A changed classification must remain continuous for this long. */
export const MAG_STATE_DEBOUNCE_MS = 800

export interface MagInterferenceReading {
  /** Latest total field magnitude, without windowing or averaging. */
  fieldGauss: number
  /** Debounced, hysteresis-stabilized interference classification. */
  warning: boolean
}

export interface MagInterferenceDetector {
  /** Feed the latest field magnitude and receive the current stable reading. */
  update: (fieldGauss: number, tsMs: number) => MagInterferenceReading | null
  reset: () => void
}

/** Total field magnitude in Gauss from mGauss components. */
export function magFieldFromMilliGauss(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z) / 1000
}

export function createMagInterferenceDetector(): MagInterferenceDetector {
  let stableWarning: boolean | null = null
  let pendingWarning: boolean | null = null
  let pendingSince = 0
  let lastTimestamp = Number.NEGATIVE_INFINITY

  const classify = (fieldGauss: number): boolean => {
    if (stableWarning !== true) {
      return fieldGauss < MAG_FIELD_MIN_GAUSS || fieldGauss > MAG_FIELD_MAX_GAUSS
    }
    // Once warning, remain warning until the value is clearly back inside the
    // healthy band. This is the spatial half of the anti-flicker behavior.
    return fieldGauss < MAG_FIELD_MIN_GAUSS + MAG_FIELD_HYSTERESIS_GAUSS
      || fieldGauss > MAG_FIELD_MAX_GAUSS - MAG_FIELD_HYSTERESIS_GAUSS
  }

  return {
    update(fieldGauss, tsMs) {
      if (!Number.isFinite(fieldGauss) || !Number.isFinite(tsMs)) return null
      // A reconnect or test clock can move backwards; treat it as a fresh
      // stream instead of carrying an impossible pending duration forward.
      if (tsMs < lastTimestamp) {
        stableWarning = null
        pendingWarning = null
      }
      lastTimestamp = tsMs

      const nextWarning = classify(fieldGauss)
      if (stableWarning === null) {
        // The first live value is useful immediately; debounce only subsequent
        // transitions where flicker is possible.
        stableWarning = nextWarning
      } else if (nextWarning === stableWarning) {
        pendingWarning = null
      } else if (pendingWarning !== nextWarning) {
        pendingWarning = nextWarning
        pendingSince = tsMs
      } else if (tsMs - pendingSince >= MAG_STATE_DEBOUNCE_MS) {
        stableWarning = nextWarning
        pendingWarning = null
      }

      return { fieldGauss, warning: stableWarning }
    },
    reset() {
      stableWarning = null
      pendingWarning = null
      pendingSince = 0
      lastTimestamp = Number.NEGATIVE_INFINITY
    },
  }
}
