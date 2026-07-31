import type { CalibrationSide } from '../../../shared/types'

type Point3 = readonly [x: number, y: number, z: number]
type Point2 = readonly [x: number, y: number]

const HALF_PI = Math.PI / 2

const ORIENTATION_ROTATION: Record<CalibrationSide, { roll: number; pitch: number }> = {
  down: { roll: 0, pitch: 0 },
  up: { roll: Math.PI, pitch: 0 },
  left: { roll: HALF_PI, pitch: 0 },
  right: { roll: -HALF_PI, pitch: 0 },
  front: { roll: 0, pitch: HALF_PI },
  back: { roll: 0, pitch: -HALF_PI },
}

const MOTORS: readonly Point3[] = [
  [1.28, -1.02, 0.08],
  [1.28, 1.02, 0.08],
  [-1.28, -1.02, 0.08],
  [-1.28, 1.02, 0.08],
]

const LEG_TOPS: readonly Point3[] = [
  [-0.34, -0.27, -0.16], [0.34, -0.27, -0.16],
  [-0.34, 0.27, -0.16], [0.34, 0.27, -0.16],
]

const BODY_CORNERS: readonly Point3[] = [
  [-0.5, -0.38, -0.18], [0.5, -0.38, -0.18],
  [0.5, 0.38, -0.18], [-0.5, 0.38, -0.18],
  [-0.5, -0.38, 0.18], [0.5, -0.38, 0.18],
  [0.5, 0.38, 0.18], [-0.5, 0.38, 0.18],
]

const BODY_FACES = [
  { name: 'bottom', indexes: [0, 1, 2, 3] },
  { name: 'rear', indexes: [0, 3, 7, 4] },
  { name: 'front', indexes: [1, 2, 6, 5] },
  { name: 'left', indexes: [0, 1, 5, 4] },
  { name: 'right', indexes: [3, 2, 6, 7] },
  { name: 'top', indexes: [4, 5, 6, 7] },
] as const

const MODEL_BOUNDS: Point3[] = [
  ...BODY_CORNERS,
  ...MOTORS.flatMap(([x, y]) => [
    [x - 0.62, y, 0.22] as Point3,
    [x + 0.62, y, 0.22] as Point3,
    [x, y - 0.62, 0.22] as Point3,
    [x, y + 0.62, 0.22] as Point3,
  ]),
  [-0.35, -0.28, -0.56], [0.35, -0.28, -0.56],
  [-0.35, 0.28, -0.56], [0.35, 0.28, -0.56],
]

function rotate(point: Point3, side: CalibrationSide): Point3 {
  const { roll, pitch } = ORIENTATION_ROTATION[side]
  const [x, y, z] = point
  const rolledY = y * Math.cos(roll) - z * Math.sin(roll)
  const rolledZ = y * Math.sin(roll) + z * Math.cos(roll)
  return [
    x * Math.cos(pitch) + rolledZ * Math.sin(pitch),
    rolledY,
    -x * Math.sin(pitch) + rolledZ * Math.cos(pitch),
  ]
}

function project([x, y, z]: Point3): Point2 {
  return [80 + (x - y) * 13, 62 + (x + y) * 6 - z * 21]
}

function pointsAttribute(points: readonly Point2[]): string {
  return points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
}

function pathAttribute(points: readonly Point2[]): string {
  return `${points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')}Z`
}

export default function AccelOrientationVisual({
  side,
  label,
  instruction,
}: {
  side: CalibrationSide
  label: string
  instruction: string
}) {
  const lowestZ = Math.min(...MODEL_BOUNDS.map((point) => rotate(point, side)[2]))
  const groundOffset = -lowestZ + 0.04
  const world = (point: Point3): Point3 => {
    const [x, y, z] = rotate(point, side)
    return [x, y, z + groundOffset]
  }
  const screen = (point: Point3): Point2 => project(world(point))
  const averageDepth = (points: readonly Point3[]): number =>
    points.reduce((total, [x, y, z]) => total + x + y + z * 0.25, 0) / points.length

  const faces = BODY_FACES.map((face) => {
    const points = face.indexes.map((index) => world(BODY_CORNERS[index]))
    return { ...face, points, depth: averageDepth(points) }
  }).sort((a, b) => a.depth - b.depth)

  const motors = MOTORS.map((center, index) => ({ center, index, depth: averageDepth([world(center)]) }))
    .sort((a, b) => a.depth - b.depth)

  const rotorDisc = (center: Point3): string => {
    const points: Point2[] = []
    for (let index = 0; index < 24; index++) {
      const angle = (index / 24) * Math.PI * 2
      points.push(screen([
        center[0] + Math.cos(angle) * 0.56,
        center[1] + Math.sin(angle) * 0.56,
        center[2] + 0.14,
      ]))
    }
    return pathAttribute(points)
  }

  const ground = pointsAttribute([
    project([-3.25, -2.35, 0]),
    project([3.25, -2.35, 0]),
    project([3.25, 2.35, 0]),
    project([-3.25, 2.35, 0]),
  ])

  return (
    <svg className="mc-orientation-visual" viewBox="0 0 160 108" role="img" aria-label={`${label}示意图`}>
      <title>{label}：{instruction}</title>
      <polygon className="mc-orientation-visual__ground" points={ground} />
      <path className="mc-orientation-visual__ground-line" d="M24 82L80 108M54 68L111 95M82 55L139 81" />
      <ellipse className="mc-orientation-visual__shadow" cx="80" cy="70" rx="25" ry="8" />

      <g className="mc-orientation-drone">
        {MOTORS.map(([x, y], index) => {
          const start: Point3 = [Math.sign(x) * 0.28, Math.sign(y) * 0.2, 0]
          const end: Point3 = [x, y, 0.06]
          return (
            <g key={`arm-${index}`}>
              <line className="mc-orientation-drone__arm-shadow" x1={screen(start)[0]} y1={screen(start)[1]} x2={screen(end)[0]} y2={screen(end)[1]} />
              <line className="mc-orientation-drone__arm" x1={screen(start)[0]} y1={screen(start)[1]} x2={screen(end)[0]} y2={screen(end)[1]} />
            </g>
          )
        })}

        {LEG_TOPS.map((point, index) => {
          const foot: Point3 = [point[0], point[1], -0.55]
          return <line key={`leg-${index}`} className="mc-orientation-drone__leg" x1={screen(point)[0]} y1={screen(point)[1]} x2={screen(foot)[0]} y2={screen(foot)[1]} />
        })}

        {motors.map(({ center, index }) => {
          const propAxis = index % 2 === 0
            ? [[center[0] - 0.58, center[1], center[2] + 0.16], [center[0] + 0.58, center[1], center[2] + 0.16]] as const
            : [[center[0], center[1] - 0.58, center[2] + 0.16], [center[0], center[1] + 0.58, center[2] + 0.16]] as const
          const motorBottom: Point3 = [center[0], center[1], center[2] - 0.13]
          const motorTop: Point3 = [center[0], center[1], center[2] + 0.15]
          return (
            <g key={`motor-${index}`}>
              <path className="mc-orientation-drone__rotor-disc" d={rotorDisc(center)} />
              <line className="mc-orientation-drone__propeller" x1={screen(propAxis[0])[0]} y1={screen(propAxis[0])[1]} x2={screen(propAxis[1])[0]} y2={screen(propAxis[1])[1]} />
              <line className="mc-orientation-drone__motor" x1={screen(motorBottom)[0]} y1={screen(motorBottom)[1]} x2={screen(motorTop)[0]} y2={screen(motorTop)[1]} />
              <circle className="mc-orientation-drone__hub" cx={screen(motorTop)[0]} cy={screen(motorTop)[1]} r="2.1" />
            </g>
          )
        })}

        {faces.map((face) => (
          <polygon
            key={face.name}
            className={`mc-orientation-drone__body mc-orientation-drone__body--${face.name}`}
            points={pointsAttribute(face.points.map(project))}
          />
        ))}

        <polygon
          className="mc-orientation-drone__nose"
          points={pointsAttribute([
            screen([0.48, -0.22, 0.2]),
            screen([0.92, 0, 0.2]),
            screen([0.48, 0.22, 0.2]),
          ])}
        />
      </g>
    </svg>
  )
}
