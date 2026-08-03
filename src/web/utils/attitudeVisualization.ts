type AttitudeEuler = {
  roll: number
  pitch: number
  yaw: number
}

/**
 * Convert MAVLink's aircraft body axes (forward, right, down) to the model's
 * Three.js axes (right, up, backward). The model nose points toward -Z, so
 * positive aircraft roll is a negative rotation around the model's Z axis.
 */
export function attitudeToModelRotation(attitude: AttitudeEuler) {
  return {
    x: attitude.pitch,
    y: -attitude.yaw,
    z: -attitude.roll,
  }
}

/** The artificial horizon moves opposite to the aircraft's bank angle. */
export function attitudeToHorizonTransform(rollDegrees: number, pitchDegrees: number): string {
  return `rotate(${(-rollDegrees).toFixed(1)}deg) translateY(${(-pitchDegrees * 1.15).toFixed(1)}%)`
}
