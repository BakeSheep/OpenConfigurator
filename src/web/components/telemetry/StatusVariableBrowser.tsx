import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../ui/Icon'
import { useConnectionStore, type LinkStats } from '../../stores/connectionStore'
import { useSensorStore } from '../../stores/sensorStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import type { RcChannelsData } from '../../../shared/types'

interface StatusEntry {
  name: string
  value: string | null
  unit?: string
}

export interface StatusGroup {
  name: string
  entries: StatusEntry[]
}

type TelemetrySnapshot = ReturnType<typeof useTelemetryStore.getState>
type SensorSnapshot = ReturnType<typeof useSensorStore.getState>

// High-rate telemetry arrives at tens of Hz. Subscribing to the whole stores
// would rebuild the entire variable tree for every message, so the browser
// (and the dashboard custom board) samples a snapshot at a fixed interval.
export const STATUS_SNAPSHOT_INTERVAL_MS = 500

export function readStatusVariableSnapshot() {
  return {
    telemetry: useTelemetryStore.getState(),
    sensors: useSensorStore.getState(),
    linkStats: useConnectionStore.getState().linkStats,
  }
}

export type StatusVariableSnapshot = ReturnType<typeof readStatusVariableSnapshot>

const RAD2DEG = 180 / Math.PI

function num(value: number | null | undefined, digits = 4): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return value.toFixed(digits)
}

function int(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return String(Math.round(value))
}

function bool(value: boolean | null | undefined): string | null {
  if (value == null) return null
  return value ? 'true' : 'false'
}

// Assemble the display tree from what the stores actually hold. A stale field
// (lastUpdate === 0, e.g. after disconnect) renders as "--" instead of a
// frozen number so the operator never reads dead data as live.
// Exported so DashboardPage's custom data board can offer the same variables.
export function buildGroups(t: TelemetrySnapshot, s: SensorSnapshot, link: LinkStats | null): StatusGroup[] {
  const att = t.lastUpdate.attitude > 0 ? t.attitude : null
  const vfr = t.lastUpdate.vfrHud > 0
  const gp = t.lastUpdate.globalPosition > 0 ? t.globalPosition : null
  const hb = t.lastUpdate.status > 0 ? t.status : null
  const bat = t.lastUpdate.battery > 0 || t.lastUpdate.sysStatus > 0 ? t.battery : null
  const gps = t.lastUpdate.gps > 0 ? t.gps : null
  const ekf = t.lastUpdate.ekfStatus > 0 ? t.ekfStatus : null
  const rc = t.lastUpdate.rcChannels > 0 ? t.rcChannels : null
  const motors = t.lastUpdate.motorOutputs > 0 ? t.motorOutputs : null
  const sys = t.lastUpdate.sysStatus > 0
  const baro = s.lastUpdate.baro > 0 ? s.baro : null
  const flow = s.lastUpdate.opticalFlow > 0 ? s.opticalFlow : null
  const range = s.lastUpdate.distanceSensor > 0 ? s.distanceSensor : null
  const imuFresh = s.lastUpdate.imu > 0
  const av = t.autopilotVersion

  const groups: StatusGroup[] = []

  groups.push({
    name: 'VEHICLE',
    entries: [
      { name: 'airSpeed', value: vfr ? num(t.airSpeed) : null, unit: 'm/s' },
      { name: 'groundSpeed', value: vfr ? num(t.groundSpeed) : null, unit: 'm/s' },
      { name: 'climbRate', value: vfr ? num(t.climbRate) : null, unit: 'm/s' },
      { name: 'altitudeAMSL', value: vfr ? num(t.altitude) : null, unit: 'm' },
      { name: 'altitudeRelative', value: gp ? num(t.relativeAlt) : null, unit: 'm' },
      { name: 'heading', value: vfr ? int(t.heading) : null, unit: 'deg' },
      { name: 'throttlePct', value: vfr ? int(t.throttle) : null, unit: '%' },
      { name: 'roll', value: att ? num(att.roll * RAD2DEG) : null, unit: 'deg' },
      { name: 'pitch', value: att ? num(att.pitch * RAD2DEG) : null, unit: 'deg' },
      { name: 'yaw', value: att ? num(att.yaw * RAD2DEG) : null, unit: 'deg' },
      { name: 'rollRate', value: att ? num(att.rollspeed * RAD2DEG) : null, unit: 'deg/s' },
      { name: 'pitchRate', value: att ? num(att.pitchspeed * RAD2DEG) : null, unit: 'deg/s' },
      { name: 'yawRate', value: att ? num(att.yawspeed * RAD2DEG) : null, unit: 'deg/s' },
      { name: 'flightMode', value: hb?.mode ?? null },
      { name: 'armed', value: bool(hb ? hb.armed : null) },
      { name: 'failsafe', value: hb?.failsafe ?? null },
      { name: 'systemStatus', value: hb ? int(hb.systemStatus) : null },
    ],
  })

  groups.push({
    name: 'BATTERY0',
    entries: [
      { name: 'id', value: bat ? int(bat.id) : null },
      { name: 'voltage', value: bat ? num(bat.voltage, 2) : null, unit: 'V' },
      { name: 'current', value: bat ? num(bat.current, 2) : null, unit: 'A' },
      { name: 'percentRemaining', value: bat ? int(bat.remaining) : null, unit: '%' },
      { name: 'mahConsumed', value: bat ? int(bat.consumed_mah) : null, unit: 'mAh' },
      ...(bat?.cell_voltages ?? []).map((cell, index) => ({
        name: `cellVoltage${index + 1}`,
        value: num(cell, 3),
        unit: 'V',
      })),
    ],
  })

  groups.push({
    name: 'GPS',
    entries: [
      { name: 'fixType', value: gps ? int(gps.fix_type) : null },
      { name: 'lat', value: gps ? num(gps.lat, 7) : null, unit: 'deg' },
      { name: 'lon', value: gps ? num(gps.lon, 7) : null, unit: 'deg' },
      { name: 'altitudeMSL', value: gps ? num(gps.alt, 2) : null, unit: 'm' },
      { name: 'eph', value: gps ? num(gps.eph, 2) : null },
      { name: 'epv', value: gps ? num(gps.epv, 2) : null },
      { name: 'velocity', value: gps ? num(gps.vel, 2) : null, unit: 'm/s' },
      { name: 'courseOverGround', value: gps ? num(gps.cog, 2) : null, unit: 'deg' },
      { name: 'satellitesVisible', value: gps ? int(gps.satellites_visible) : null },
    ],
  })

  groups.push({
    name: 'POSITION',
    entries: [
      { name: 'lat', value: gp ? num(gp.lat, 7) : null, unit: 'deg' },
      { name: 'lon', value: gp ? num(gp.lon, 7) : null, unit: 'deg' },
      { name: 'alt', value: gp ? num(gp.alt, 2) : null, unit: 'm' },
      { name: 'relativeAlt', value: gp ? num(gp.relative_alt, 2) : null, unit: 'm' },
      { name: 'vx', value: gp ? num(gp.vx, 2) : null, unit: 'm/s' },
      { name: 'vy', value: gp ? num(gp.vy, 2) : null, unit: 'm/s' },
      { name: 'vz', value: gp ? num(gp.vz, 2) : null, unit: 'm/s' },
      { name: 'hdg', value: gp ? num(gp.hdg, 2) : null, unit: 'deg' },
    ],
  })

  const imuInstances = Object.keys(s.imus).map(Number).sort((a, b) => a - b)
  for (const instance of imuInstances.length > 0 ? imuInstances : [0]) {
    const imu = imuFresh ? s.imus[instance] ?? null : null
    groups.push({
      name: `IMU${instance}`,
      entries: [
        { name: 'xacc', value: imu ? num(imu.xacc) : null },
        { name: 'yacc', value: imu ? num(imu.yacc) : null },
        { name: 'zacc', value: imu ? num(imu.zacc) : null },
        { name: 'xgyro', value: imu ? num(imu.xgyro) : null },
        { name: 'ygyro', value: imu ? num(imu.ygyro) : null },
        { name: 'zgyro', value: imu ? num(imu.zgyro) : null },
        { name: 'xmag', value: imu ? num(imu.xmag) : null },
        { name: 'ymag', value: imu ? num(imu.ymag) : null },
        { name: 'zmag', value: imu ? num(imu.zmag) : null },
        { name: 'temperature', value: imu ? num(imu.temperature, 1) : null, unit: 'C' },
      ],
    })
  }

  groups.push({
    name: 'BAROMETER',
    entries: [
      { name: 'pressAbs', value: baro ? num(baro.press_abs, 2) : null, unit: 'hPa' },
      { name: 'pressDiff', value: baro ? num(baro.press_diff, 4) : null, unit: 'hPa' },
      { name: 'temperature', value: baro ? num(baro.temperature, 1) : null, unit: 'C' },
      { name: 'altitude', value: baro ? num(baro.altitude, 2) : null, unit: 'm' },
    ],
  })

  groups.push({
    name: 'DISTANCESENSOR',
    entries: [
      { name: 'currentDistance', value: range ? num(range.current_distance, 2) : null, unit: 'm' },
      { name: 'minDistance', value: range ? num(range.min_distance, 2) : null, unit: 'm' },
      { name: 'maxDistance', value: range ? num(range.max_distance, 2) : null, unit: 'm' },
      { name: 'signalQuality', value: range ? int(range.signal_quality) : null, unit: '%' },
      { name: 'type', value: range ? int(range.type) : null },
      { name: 'id', value: range ? int(range.id) : null },
      { name: 'orientation', value: range ? int(range.orientation) : null },
    ],
  })

  groups.push({
    name: 'OPTICALFLOW',
    entries: [
      { name: 'quality', value: flow ? int(flow.quality) : null },
      { name: 'integratedX', value: flow ? num(flow.integrated_x_rad) : null, unit: 'rad' },
      { name: 'integratedY', value: flow ? num(flow.integrated_y_rad) : null, unit: 'rad' },
      { name: 'integratedXGyro', value: flow ? num(flow.integrated_xgyro_rad) : null, unit: 'rad' },
      { name: 'integratedYGyro', value: flow ? num(flow.integrated_ygyro_rad) : null, unit: 'rad' },
      { name: 'integratedZGyro', value: flow ? num(flow.integrated_zgyro_rad) : null, unit: 'rad' },
      { name: 'distance', value: flow ? num(flow.distance_m, 2) : null, unit: 'm' },
      { name: 'temperature', value: flow ? num(flow.temperature_c, 1) : null, unit: 'C' },
    ],
  })

  groups.push({
    name: 'ESTIMATORSTATUS',
    entries: [
      { name: 'healthFlags', value: ekf ? `0x${ekf.health_flags.toString(16).toUpperCase()}` : null },
      { name: 'velInnovation', value: ekf ? num(ekf.innovation_vel) : null },
      { name: 'posInnovation', value: ekf ? num(ekf.innovation_pos) : null },
      { name: 'hgtInnovation', value: ekf ? num(ekf.innovation_hgt) : null },
      { name: 'magInnovation', value: ekf ? num(ekf.innovation_mag) : null },
    ],
  })

  groups.push({
    name: 'RCCHANNELS',
    entries: Array.from({ length: 18 }, (_, index): StatusEntry | null => {
      const key = `ch${index + 1}` as keyof RcChannelsData
      const value = rc ? rc[key] : null
      if (index >= 8 && value == null) return null
      return { name: key, value: int(value), unit: 'µs' }
    }).filter((entry) => entry !== null),
  })

  groups.push({
    name: 'SERVOOUTPUT',
    entries: [
      { name: 'port', value: motors ? int(motors.port) : null },
      ...(motors?.outputs ?? Array.from({ length: 8 }, () => null)).map((output, index) => ({
        name: `servo${index + 1}`,
        value: int(output),
        unit: 'µs',
      })),
    ],
  })

  groups.push({
    name: 'SYSTEM',
    entries: [
      { name: 'sensorsHealthy', value: sys ? bool(t.sensorsHealthy) : null },
      { name: 'preflightCheck', value: sys ? bool(t.preflightCheck) : null },
      {
        name: 'unhealthySensors',
        value: sys ? (t.unhealthySensors.length > 0 ? t.unhealthySensors.join(', ') : 'none') : null,
      },
    ],
  })

  groups.push({
    name: 'FIRMWARE',
    entries: [
      { name: 'boardName', value: av?.boardName ?? null },
      { name: 'boardId', value: av ? int(av.boardId) : null },
      { name: 'firmwareVersion', value: av?.firmwareVersion ?? null },
      { name: 'firmwareLabel', value: av?.firmwareLabel ?? null },
      { name: 'vendorId', value: av ? `0x${av.vendorId.toString(16).toUpperCase()}` : null },
      { name: 'productId', value: av ? `0x${av.productId.toString(16).toUpperCase()}` : null },
    ],
  })

  groups.push({
    name: 'LINK',
    entries: [
      { name: 'rxBps', value: link ? int(link.rxBps) : null, unit: 'B/s' },
      { name: 'txBps', value: link ? int(link.txBps) : null, unit: 'B/s' },
      { name: 'crcErrors', value: link ? int(link.crcErrors) : null },
      { name: 'crcErrorsPerSec', value: link ? num(link.crcErrorsPerSec, 1) : null, unit: '/s' },
      { name: 'rxPackets', value: link ? int(link.rxPackets) : null },
      { name: 'txPackets', value: link ? int(link.txPackets) : null },
      { name: 'rxSequenceLost', value: link ? int(link.rxSequenceLost) : null },
      { name: 'rxDuplicates', value: link ? int(link.rxDuplicates) : null },
      { name: 'protocolVersion', value: link?.protocolVersion != null ? `v${link.protocolVersion}` : null },
    ],
  })

  return groups
}

// Column-major split so variables read alphabetically down each column, the
// same way MicoConfigurator / QGC lay out their status console.
function splitColumns(entries: StatusEntry[], columns: number): StatusEntry[][] {
  const rows = Math.ceil(entries.length / columns)
  return Array.from({ length: columns }, (_, index) => entries.slice(index * rows, (index + 1) * rows))
}

export default function StatusVariableBrowser({ paused = false }: { paused?: boolean }) {
  const [snapshot, setSnapshot] = useState(readStatusVariableSnapshot)
  useEffect(() => {
    const timer = window.setInterval(
      () => setSnapshot(readStatusVariableSnapshot()),
      STATUS_SNAPSHOT_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [])
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const liveGroups = useMemo(
    () => buildGroups(snapshot.telemetry, snapshot.sensors, snapshot.linkStats),
    [snapshot],
  )
  // While paused, keep rendering the snapshot captured at pause time.
  const frozenRef = useRef<StatusGroup[] | null>(null)
  if (paused) {
    if (!frozenRef.current) frozenRef.current = liveGroups
  } else {
    frozenRef.current = null
  }
  const groups = frozenRef.current ?? liveGroups

  const totalCount = groups.reduce((count, group) => count + group.entries.length, 0)
  const needle = query.trim().toLowerCase()
  const visibleGroups = needle
    ? groups
        .map((group) => ({
          ...group,
          entries: group.name.toLowerCase().includes(needle)
            ? group.entries
            : group.entries.filter((entry) => entry.name.toLowerCase().includes(needle)),
        }))
        .filter((group) => group.entries.length > 0)
    : groups
  const visibleCount = visibleGroups.reduce((count, group) => count + group.entries.length, 0)

  const toggleGroup = (name: string) => setCollapsed((current) => ({ ...current, [name]: !current[name] }))

  return (
    <div className="mc-statusvar">
      <div className="mc-statusvar__toolbar">
        <div className="mc-statusvar__search">
          <Icon name="search" size={14} />
          <input
            type="text"
            value={query}
            placeholder="搜索变量名…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="mc-statusvar__count mc-mono">{visibleCount} / {totalCount}</span>
      </div>

      {visibleGroups.length === 0 ? (
        <p className="mc-statusvar__empty">没有匹配 “{query.trim()}” 的状态变量</p>
      ) : (
        visibleGroups.map((group) => {
          // A live search always expands its matches.
          const isCollapsed = needle ? false : collapsed[group.name] === true
          return (
            <section key={group.name} className="mc-card mc-statusvar-group" data-collapsed={isCollapsed || undefined}>
              <header onClick={() => toggleGroup(group.name)}>
                <span className="mc-statusvar-group__chevron"><Icon name="chevronDown" size={14} /></span>
                <h3>{group.name}</h3>
                <span className="mc-statusvar-group__badge mc-mono">{group.entries.length}</span>
              </header>
              {!isCollapsed && (
                <div className="mc-statusvar-grid">
                  {splitColumns(group.entries, 3).map((column, columnIndex) => (
                    <div key={columnIndex} className="mc-statusvar-col">
                      {column.map((entry) => (
                        <div key={entry.name} className="mc-statusvar-row" data-empty={entry.value == null || undefined}>
                          <code>{entry.name}</code>
                          <span>
                            <b>{entry.value ?? '--'}</b>
                            {entry.value != null && entry.unit && <i>{entry.unit}</i>}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
