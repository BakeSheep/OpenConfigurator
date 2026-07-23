const QUAD_X_IDS = new Set([
  1001, 1100, 4001, 4003, 4009, 4014, 4015, 4016, 4017, 4019, 4020,
  4050, 4052, 4053, 4061, 4071, 4073, 4500, 4601, 4901,
])

interface Px4AirframeInfo {
  cardId?: string
  name: string
}

const exactAirframes: Record<number, Px4AirframeInfo> = {
  4001: { cardId: 'quad-x', name: 'Generic Quadrotor X' },
  4040: { name: 'Quadrotor H' },
  4041: { name: 'Quadrotor H' },
  4051: { name: 'Quadrotor Asymmetric' },
  5001: { cardId: 'quad-plus', name: 'Generic Quadrotor +' },
  6001: { cardId: 'hexa-x', name: 'Generic Hexarotor X' },
  7001: { cardId: 'hexa-plus', name: 'Generic Hexarotor +' },
  8001: { cardId: 'octo-x', name: 'Generic Octorotor X' },
  9001: { cardId: 'octo-plus', name: 'Generic Octorotor +' },
  11001: { cardId: 'hexa-coax', name: 'Generic Hexarotor Coaxial' },
  12001: { name: 'Generic Octorotor Coaxial' },
}

export function getPx4AirframeInfo(value: number | undefined): Px4AirframeInfo | null {
  if (!Number.isFinite(value) || !value) return null
  const autostart = Math.round(value!)
  const exact = exactAirframes[autostart]
  if (exact) return exact
  if (QUAD_X_IDS.has(autostart)) return { cardId: 'quad-x', name: 'Quadrotor X' }
  return { name: `PX4 Airframe #${autostart}` }
}
