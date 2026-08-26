// Demo-mode calibration driver.
//
// In demo runtime there is no local Worker connection, so this module simulates a
// calibration session locally: it consumes the same RuntimeCommand shapes the
// live UI sends and produces valid (sessionId, seq) CalibrationSnapshots plus
// snapshots. It does NOT clone a second UI state machine; it drives the same calibrationStore the live path
// feeds. All timers are injectable and tracked so they can be cleared.
import type {
  AccelCalibrationPosition,
  CalibrationKind,
  CalibrationSide,
  CalibrationSnapshot,
  CalibrationVerification,
  RuntimeCommand,
} from '../../shared/types'

const SIDE_ORDER: CalibrationSide[] = ['down', 'left', 'right', 'front', 'back', 'up']
const POSITION_SIDE: Record<AccelCalibrationPosition, CalibrationSide> = {
  1: 'down', 2: 'left', 3: 'right', 4: 'front', 5: 'back', 6: 'up',
}

export interface CalibrationDemoDeps {
  applySnapshot: (snapshot: CalibrationSnapshot) => void
  family: () => 'px4' | 'ardupilot'
  ownerClientId: () => string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Deterministic id source for tests; defaults to a random-ish string. */
  makeId?: () => string
}

export interface CalibrationDemo {
  handleRuntimeCommand: (msg: RuntimeCommand) => boolean
  stop: () => void
}

const STEP_MS = 700

export function createCalibrationDemo(deps: CalibrationDemoDeps): CalibrationDemo {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let idCounter = 0
  const makeId = deps.makeId ?? (() => `demo-${Date.now().toString(36)}-${idCounter++}`)

  const timers = new Set<unknown>()
  let session: {
    sessionId: string
    requestId: string
    kind: CalibrationKind
    family: 'px4' | 'ardupilot'
    seq: number
    sides?: Record<CalibrationSide, 'hidden' | 'pending' | 'active' | 'done'>
    position?: AccelCalibrationPosition | null
    magPct?: number
  } | null = null

  const clearAllTimers = (): void => {
    for (const handle of timers) clearTimer(handle)
    timers.clear()
  }

  const schedule = (fn: () => void, ms: number): void => {
    const handle = setTimer(() => {
      timers.delete(handle)
      fn()
    }, ms)
    timers.add(handle)
  }

  const emit = (patch: Partial<CalibrationSnapshot>): void => {
    if (!session) return
    session.seq += 1
    const snapshot: CalibrationSnapshot = {
      sessionId: session.sessionId,
      seq: session.seq,
      ownerClientId: deps.ownerClientId(),
      recoverUntil: null,
      requestId: session.requestId,
      family: session.family,
      kind: session.kind,
      phase: 'running',
      verification: 'not_applicable',
      progress: null,
      updatedAt: now(),
      rebootRequired: false,
      cancelSupported: session.family === 'px4' || session.kind === 'mag',
      ...(session.sides ? { sides: { ...session.sides } } : {}),
      ...patch,
    }
    deps.applySnapshot(snapshot)
  }

  const allSides = (): Record<CalibrationSide, 'pending'> => ({
    down: 'pending', up: 'pending', left: 'pending',
    right: 'pending', front: 'pending', back: 'pending',
  })

  // -- PX4 six-side accel / mag auto-advancing script --------------------------
  const runPx4Sides = (index: number): void => {
    if (!session || !session.sides) return
    if (index >= SIDE_ORDER.length) {
      for (const side of SIDE_ORDER) session.sides[side] = 'done'
      emit({ phase: 'done', verification: 'verified', progress: 100 })
      return
    }
    const side = SIDE_ORDER[index]
    session.sides[side] = 'active'
    emit({ phase: 'running', progress: Math.round((index / SIDE_ORDER.length) * 100) })
    schedule(() => {
      if (!session?.sides) return
      session.sides[side] = 'done'
      emit({ phase: 'running', progress: Math.round(((index + 1) / SIDE_ORDER.length) * 100) })
      schedule(() => runPx4Sides(index + 1), STEP_MS)
    }, STEP_MS)
  }

  // -- One-shot (gyro/baro/level, simple accel) --------------------------------
  const runOneShot = (verification: CalibrationVerification): void => {
    emit({ phase: 'running' })
    schedule(() => {
      emit(verification === 'verified'
        ? { phase: 'done', verification: 'verified', progress: 100 }
        : { phase: 'accepted', verification: 'ack_only' })
    }, STEP_MS)
  }

  // -- ArduPilot interactive accel: wait for the user at each position ---------
  const requestPosition = (position: AccelCalibrationPosition): void => {
    if (!session?.sides) return
    session.position = position
    if (position > 1) session.sides[POSITION_SIDE[(position - 1) as AccelCalibrationPosition]] = 'done'
    session.sides[POSITION_SIDE[position]] = 'active'
    emit({ phase: 'waiting_position', requestedPosition: position })
  }

  // -- ArduPilot mag: progress then a report awaiting accept -------------------
  const runMagProgress = (pct: number): void => {
    if (!session) return
    session.magPct = pct
    if (pct >= 100) {
      emit({
        phase: 'awaiting_accept',
        progress: 100,
        expectedMagMask: 0b001,
        magInstances: [{ id: 0, pct: 100, status: 4, attempt: 1, report: { status: 4, fitness: 6.2, ofs: [45, -30, 60], autosaved: false } }],
      })
      return
    }
    emit({
      phase: 'running',
      progress: pct,
      expectedMagMask: 0b001,
      magInstances: [{ id: 0, pct, status: 2, attempt: 1 }],
    })
    schedule(() => runMagProgress(pct + 20), STEP_MS)
  }

  const startSession = (msg: Extract<RuntimeCommand, { type: 'start_calibration' }>): void => {
    clearAllTimers()
    const sessionId = makeId()
    session = {
      sessionId,
      requestId: msg.requestId,
      kind: msg.data.kind,
      family: deps.family(),
      seq: 0,
    }
    emit({ phase: 'starting' })

    const { kind, family } = session
    if (family === 'ardupilot' && kind === 'accel') {
      session.sides = allSides()
      schedule(() => requestPosition(1), STEP_MS)
    } else if (family === 'ardupilot' && kind === 'mag') {
      schedule(() => runMagProgress(20), STEP_MS)
    } else if (kind === 'accel' || kind === 'mag') {
      session.sides = kind === 'mag'
        ? { down: 'pending', up: 'pending', left: 'pending', right: 'pending', front: 'pending', back: 'pending' }
        : allSides()
      schedule(() => runPx4Sides(0), STEP_MS)
    } else if (family === 'ardupilot' && (kind === 'accel_simple' || kind === 'level' || kind === 'gyro' || kind === 'baro')) {
      schedule(() => runOneShot('ack_only'), STEP_MS)
    } else {
      runOneShot('verified')
    }
  }

  const handleAction = (msg: Extract<RuntimeCommand, { type: 'calibration_action' }>): void => {
    if (!session || msg.data.sessionId !== session.sessionId) return
    if (msg.data.action === 'cancel') {
      clearAllTimers()
      emit({ phase: 'cancelled', verification: 'verified' })
      return
    }
    if (msg.data.action === 'confirm_position' && session.position === msg.data.position) {
      const next = (msg.data.position + 1) as AccelCalibrationPosition
      session.position = null
      emit({ phase: 'running' })
      if (msg.data.position >= 6) {
        if (session.sides) for (const side of SIDE_ORDER) session.sides[side] = 'done'
        schedule(() => emit({ phase: 'done', verification: 'verified', progress: 100 }), STEP_MS)
      } else {
        schedule(() => requestPosition(next), STEP_MS)
      }
      return
    }
    if (msg.data.action === 'accept_mag' && session.kind === 'mag') {
      schedule(() => emit({
        phase: 'done',
        verification: 'verified',
        progress: 100,
        rebootRequired: true,
        expectedMagMask: 0b001,
        magInstances: [{ id: 0, pct: 100, status: 4, attempt: 1, report: { status: 4, fitness: 6.2, ofs: [45, -30, 60], autosaved: true } }],
      }), STEP_MS)
    }
  }

  return {
    handleRuntimeCommand(msg) {
      switch (msg.type) {
        case 'start_calibration':
          startSession(msg)
          return true
        case 'calibration_action':
          handleAction(msg)
          return true
        default:
          return false
      }
    },
    stop() {
      clearAllTimers()
      session = null
    },
  }
}
