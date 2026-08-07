import i18next from 'i18next'

const t = i18next.t.bind(i18next)

const GROUP_ALIASES: Record<string, string> = {
  VEHICLE: 'Vehicle',
  BATTERY0: 'Battery0',
  GPS: 'Gps',
  DISTANCESENSOR: 'DistanceSensor',
  ESTIMATORSTATUS: 'EstimatorStatus',
}

const GROUP_COMMENTS: Record<string, string> = {
  VEHICLE: 'metadata.status.group.VEHICLE',
  BATTERY0: 'metadata.status.group.BATTERY0',
  CLOCK: 'metadata.status.group.CLOCK',
  DISTANCESENSOR: 'metadata.status.group.DISTANCESENSOR',
  ESCSTATUS0: 'metadata.status.group.ESCSTATUS0',
  ESTIMATORSTATUS: 'metadata.status.group.ESTIMATORSTATUS',
  GENERATOR: 'metadata.status.group.GENERATOR',
  GPS: 'metadata.status.group.GPS',
  GPS2: 'metadata.status.group.GPS2',
  GPSAGGREGATE: 'metadata.status.group.GPSAGGREGATE',
  HYGROMETER: 'metadata.status.group.HYGROMETER',
  LOCALPOSITION: 'metadata.status.group.LOCALPOSITION',
  LOCALPOSITIONSETPOINT: 'metadata.status.group.LOCALPOSITIONSETPOINT',
  RPM: 'metadata.status.group.RPM',
  SETPOINT: 'metadata.status.group.SETPOINT',
  TEMPERATURE: 'metadata.status.group.TEMPERATURE',
  TERRAIN: 'metadata.status.group.TERRAIN',
  VIBRATION: 'metadata.status.group.VIBRATION',
  WIND: 'metadata.status.group.WIND',
  EFI: 'metadata.status.group.EFI',
  POSITION: 'metadata.status.group.POSITION',
  BAROMETER: 'metadata.status.group.BAROMETER',
  OPTICALFLOW: 'metadata.status.group.OPTICALFLOW',
  RCCHANNELS: 'metadata.status.group.RCCHANNELS',
  SERVOOUTPUT: 'metadata.status.group.SERVOOUTPUT',
  SYSTEM: 'metadata.status.group.SYSTEM',
  FIRMWARE: 'metadata.status.group.FIRMWARE',
  LINK: 'metadata.status.group.LINK',
}

export function statusGroupDescription(groupName: string): string | null {
  const normalized = groupName.toUpperCase()
  if (/^IMU\d+$/.test(normalized)) return t('metadata.status.group.IMU')
  if (normalized.startsWith('COMPASS_')) return t('metadata.status.group.COMPASS')
  const key = GROUP_COMMENTS[normalized]
  return key ? t(key) : null
}

const GROUP_DESCRIPTIONS: Record<string, Record<string, string>> = {
  Vehicle: {
    airSpeed: 'metadata.status.var.Vehicle.airSpeed', altitudeAboveTerr: 'metadata.status.var.Vehicle.altitudeAboveTerr', altitudeAMSL: 'metadata.status.var.Vehicle.altitudeAMSL',
    altitudeRelative: 'metadata.status.var.Vehicle.altitudeRelative', climbRate: 'metadata.status.var.Vehicle.climbRate', distanceToGCS: 'metadata.status.var.Vehicle.distanceToGCS',
    distanceToHome: 'metadata.status.var.Vehicle.distanceToHome', distanceToNextWP: 'metadata.status.var.Vehicle.distanceToNextWP', flightDistance: 'metadata.status.var.Vehicle.flightDistance',
    flightTime: 'metadata.status.var.Vehicle.flightTime', groundSpeed: 'metadata.status.var.Vehicle.groundSpeed', heading: 'metadata.status.var.Vehicle.heading',
    headingFromGCS: 'metadata.status.var.Vehicle.headingFromGCS', headingFromHome: 'metadata.status.var.Vehicle.headingFromHome',
    headingToHome: 'metadata.status.var.Vehicle.headingToHome', headingToNextWP: 'metadata.status.var.Vehicle.headingToNextWP', hobbs: 'metadata.status.var.Vehicle.hobbs',
    imuTemp: 'metadata.status.var.Vehicle.imuTemp', missionItemIndex: 'metadata.status.var.Vehicle.missionItemIndex', pitch: 'metadata.status.var.Vehicle.pitch',
    pitchRate: 'metadata.status.var.Vehicle.pitchRate', roll: 'metadata.status.var.Vehicle.roll', rollRate: 'metadata.status.var.Vehicle.rollRate',
    throttlePct: 'metadata.status.var.Vehicle.throttlePct', timeToHome: 'metadata.status.var.Vehicle.timeToHome', yawRate: 'metadata.status.var.Vehicle.yawRate',
    flightMode: 'metadata.status.var.Vehicle.flightMode', armed: 'metadata.status.var.Vehicle.armed', failsafe: 'metadata.status.var.Vehicle.failsafe',
    systemStatus: 'metadata.status.var.Vehicle.systemStatus',
  },
  Battery0: {
    batteryFunction: 'metadata.status.var.Battery0.batteryFunction', batteryType: 'metadata.status.var.Battery0.batteryType', chargeState: 'metadata.status.var.Battery0.chargeState',
    current: 'metadata.status.var.Battery0.current', id: 'metadata.status.var.Battery0.id', instantPower: 'metadata.status.var.Battery0.instantPower',
    mahConsumed: 'metadata.status.var.Battery0.mahConsumed', percentRemaining: 'metadata.status.var.Battery0.percentRemaining', temperature: 'metadata.status.var.Battery0.temperature',
    timeRemaining: 'metadata.status.var.Battery0.timeRemaining', timeRemainingStr: 'metadata.status.var.Battery0.timeRemainingStr', voltage: 'metadata.status.var.Battery0.voltage',
  },
  Clock: { currentDate: 'metadata.status.var.Clock.currentDate', currentTime: 'metadata.status.var.Clock.currentTime', currentUTCTime: 'metadata.status.var.Clock.currentUTCTime' },
  Gps: {
    authenticationState: 'metadata.status.var.Gps.authenticationState', correctionsQuality: 'metadata.status.var.Gps.correctionsQuality', count: 'metadata.status.var.Gps.count',
    courseOverGround: 'metadata.status.var.Gps.courseOverGround', gnssSignalQuality: 'metadata.status.var.Gps.gnssSignalQuality', hdop: 'metadata.status.var.Gps.hdop',
    jammingState: 'metadata.status.var.Gps.jammingState', lat: 'metadata.status.var.Gps.lat', lock: 'metadata.status.var.Gps.lock', lon: 'metadata.status.var.Gps.lon',
    mgrs: 'metadata.status.var.Gps.mgrs', postProcessingQuality: 'metadata.status.var.Gps.postProcessingQuality', spoofingState: 'metadata.status.var.Gps.spoofingState',
    systemErrors: 'metadata.status.var.Gps.systemErrors', systemQuality: 'metadata.status.var.Gps.systemQuality', vdop: 'metadata.status.var.Gps.vdop', yaw: 'metadata.status.var.Gps.yaw',
    fixType: 'metadata.status.var.Gps.fixType', altitudeMSL: 'metadata.status.var.Gps.altitudeMSL', eph: 'metadata.status.var.Gps.eph',
    epv: 'metadata.status.var.Gps.epv', velocity: 'metadata.status.var.Gps.velocity', satellitesVisible: 'metadata.status.var.Gps.satellitesVisible',
  },
  EstimatorStatus: {
    accelError: 'metadata.status.var.EstimatorStatus.accelError', goodAttitudeEsimate: 'metadata.status.var.EstimatorStatus.goodAttitudeEsimate',
    goodConstPosModeEstimate: 'metadata.status.var.EstimatorStatus.goodConstPosModeEstimate', goodHorizPosAbsEstimate: 'metadata.status.var.EstimatorStatus.goodHorizPosAbsEstimate',
    goodHorizPosRelEstimate: 'metadata.status.var.EstimatorStatus.goodHorizPosRelEstimate', goodHorizVelEstimate: 'metadata.status.var.EstimatorStatus.goodHorizVelEstimate',
    goodPredHorizPosAbsEstimate: 'metadata.status.var.EstimatorStatus.goodPredHorizPosAbsEstimate', goodPredHorizPosRelEstimate: 'metadata.status.var.EstimatorStatus.goodPredHorizPosRelEstimate',
    goodVertPosAbsEstimate: 'metadata.status.var.EstimatorStatus.goodVertPosAbsEstimate', goodVertPosAGLEstimate: 'metadata.status.var.EstimatorStatus.goodVertPosAGLEstimate',
    goodVertVelEstimate: 'metadata.status.var.EstimatorStatus.goodVertVelEstimate', gpsGlitch: 'metadata.status.var.EstimatorStatus.gpsGlitch', haglRatio: 'metadata.status.var.EstimatorStatus.haglRatio',
    horizPosAccuracy: 'metadata.status.var.EstimatorStatus.horizPosAccuracy', horizPosRatio: 'metadata.status.var.EstimatorStatus.horizPosRatio', magRatio: 'metadata.status.var.EstimatorStatus.magRatio',
    tasRatio: 'metadata.status.var.EstimatorStatus.tasRatio', velRatio: 'metadata.status.var.EstimatorStatus.velRatio', vertPosAccuracy: 'metadata.status.var.EstimatorStatus.vertPosAccuracy',
    vertPosRatio: 'metadata.status.var.EstimatorStatus.vertPosRatio', healthFlags: 'metadata.status.var.EstimatorStatus.healthFlags', velInnovation: 'metadata.status.var.EstimatorStatus.velInnovation',
    posInnovation: 'metadata.status.var.EstimatorStatus.posInnovation', hgtInnovation: 'metadata.status.var.EstimatorStatus.hgtInnovation', magInnovation: 'metadata.status.var.EstimatorStatus.magInnovation',
  },
  DistanceSensor: {
    currentDistance: 'metadata.status.var.DistanceSensor.currentDistance', minDistance: 'metadata.status.var.DistanceSensor.minDistance', maxDistance: 'metadata.status.var.DistanceSensor.maxDistance',
    signalQuality: 'metadata.status.var.DistanceSensor.signalQuality', type: 'metadata.status.var.DistanceSensor.type', id: 'metadata.status.var.DistanceSensor.id', orientation: 'metadata.status.var.DistanceSensor.orientation',
  },
  EscStatus: {
    connectionType: 'metadata.status.var.EscStatus.connectionType', count: 'metadata.status.var.EscStatus.count', current: 'metadata.status.var.EscStatus.current',
    errorCount: 'metadata.status.var.EscStatus.errorCount', failureFlags: 'metadata.status.var.EscStatus.failureFlags', id: 'metadata.status.var.EscStatus.id',
    info: 'metadata.status.var.EscStatus.info', rpm: 'metadata.status.var.EscStatus.rpm', temperature: 'metadata.status.var.EscStatus.temperature', voltage: 'metadata.status.var.EscStatus.voltage',
  },
  Generator: {
    batCurrentSetpoint: 'metadata.status.var.Generator.batCurrentSetpoint', batteryCurrent: 'metadata.status.var.Generator.batteryCurrent', busVoltage: 'metadata.status.var.Generator.busVoltage',
    genSpeed: 'metadata.status.var.Generator.genSpeed', genTemp: 'metadata.status.var.Generator.genTemp', loadCurrent: 'metadata.status.var.Generator.loadCurrent',
    powerGenerated: 'metadata.status.var.Generator.powerGenerated', rectifierTemp: 'metadata.status.var.Generator.rectifierTemp', runtime: 'metadata.status.var.Generator.runtime',
    status: 'metadata.status.var.Generator.status', timeMaintenance: 'metadata.status.var.Generator.timeMaintenance',
  },
  GpsAggregate: {
    authenticationState: 'metadata.status.var.GpsAggregate.authenticationState', isStale: 'metadata.status.var.GpsAggregate.isStale',
    jammingState: 'metadata.status.var.GpsAggregate.jammingState', spoofingState: 'metadata.status.var.GpsAggregate.spoofingState',
  },
  Hygrometer: { humidity: 'metadata.status.var.Hygrometer.humidity', hygrometerid: 'metadata.status.var.Hygrometer.hygrometerid', temperature: 'metadata.status.var.Hygrometer.temperature' },
  Rpm: {
    rpm1: 'metadata.status.var.Rpm.rpm1', rpm2: 'metadata.status.var.Rpm.rpm2', rpm3: 'metadata.status.var.Rpm.rpm3', rpm4: 'metadata.status.var.Rpm.rpm4',
    rpmSensor1: 'metadata.status.var.Rpm.rpmSensor1', rpmSensor2: 'metadata.status.var.Rpm.rpmSensor2',
  },
  Temperature: { temperature1: 'metadata.status.var.Temperature.temperature1', temperature2: 'metadata.status.var.Temperature.temperature2', temperature3: 'metadata.status.var.Temperature.temperature3' },
  Terrain: { blocksLoaded: 'metadata.status.var.Terrain.blocksLoaded', blocksPending: 'metadata.status.var.Terrain.blocksPending' },
  Vibration: {
    clipCount1: 'metadata.status.var.Vibration.clipCount1', clipCount2: 'metadata.status.var.Vibration.clipCount2', clipCount3: 'metadata.status.var.Vibration.clipCount3',
    xAxis: 'metadata.status.var.Vibration.xAxis', yAxis: 'metadata.status.var.Vibration.yAxis', zAxis: 'metadata.status.var.Vibration.zAxis',
  },
  Efi: {
    baroPress: 'metadata.status.var.Efi.baroPress', cylinderTemp: 'metadata.status.var.Efi.cylinderTemp', ecuIndex: 'metadata.status.var.Efi.ecuIndex', engineLoad: 'metadata.status.var.Efi.engineLoad',
    exGasTemp: 'metadata.status.var.Efi.exGasTemp', fuelConsumed: 'metadata.status.var.Efi.fuelConsumed', fuelFlow: 'metadata.status.var.Efi.fuelFlow', fuelPressure: 'metadata.status.var.Efi.fuelPressure',
    health: 'metadata.status.var.Efi.health', ignTime: 'metadata.status.var.Efi.ignTime', ignVoltage: 'metadata.status.var.Efi.ignVoltage', injTime: 'metadata.status.var.Efi.injTime',
    intakePress: 'metadata.status.var.Efi.intakePress', intakeTemp: 'metadata.status.var.Efi.intakeTemp', ptComp: 'metadata.status.var.Efi.ptComp', rpm: 'metadata.status.var.Efi.rpm',
    sparkTime: 'metadata.status.var.Efi.sparkTime', throttleOut: 'metadata.status.var.Efi.throttleOut', throttlePos: 'metadata.status.var.Efi.throttlePos',
  },
  POSITION: {
    lat: 'metadata.status.var.POSITION.lat', lon: 'metadata.status.var.POSITION.lon', alt: 'metadata.status.var.POSITION.alt', relativeAlt: 'metadata.status.var.POSITION.relativeAlt',
    vx: 'metadata.status.var.POSITION.vx', vy: 'metadata.status.var.POSITION.vy', vz: 'metadata.status.var.POSITION.vz', hdg: 'metadata.status.var.POSITION.hdg',
  },
  BAROMETER: { pressAbs: 'metadata.status.var.BAROMETER.pressAbs', pressDiff: 'metadata.status.var.BAROMETER.pressDiff', temperature: 'metadata.status.var.BAROMETER.temperature', altitude: 'metadata.status.var.BAROMETER.altitude' },
  OPTICALFLOW: {
    quality: 'metadata.status.var.OPTICALFLOW.quality', integratedX: 'metadata.status.var.OPTICALFLOW.integratedX', integratedY: 'metadata.status.var.OPTICALFLOW.integratedY',
    integratedXGyro: 'metadata.status.var.OPTICALFLOW.integratedXGyro', integratedYGyro: 'metadata.status.var.OPTICALFLOW.integratedYGyro',
    integratedZGyro: 'metadata.status.var.OPTICALFLOW.integratedZGyro', distance: 'metadata.status.var.OPTICALFLOW.distance', temperature: 'metadata.status.var.OPTICALFLOW.temperature',
  },
  SYSTEM: { sensorsHealthy: 'metadata.status.var.SYSTEM.sensorsHealthy', preflightCheck: 'metadata.status.var.SYSTEM.preflightCheck', unhealthySensors: 'metadata.status.var.SYSTEM.unhealthySensors' },
  FIRMWARE: {
    boardName: 'metadata.status.var.FIRMWARE.boardName', boardId: 'metadata.status.var.FIRMWARE.boardId', firmwareVersion: 'metadata.status.var.FIRMWARE.firmwareVersion',
    firmwareLabel: 'metadata.status.var.FIRMWARE.firmwareLabel', vendorId: 'metadata.status.var.FIRMWARE.vendorId', productId: 'metadata.status.var.FIRMWARE.productId',
  },
  LINK: {
    rxBps: 'metadata.status.var.LINK.rxBps', txBps: 'metadata.status.var.LINK.txBps', crcErrors: 'metadata.status.var.LINK.crcErrors',
    crcErrorsPerSec: 'metadata.status.var.LINK.crcErrorsPerSec', rxPackets: 'metadata.status.var.LINK.rxPackets', txPackets: 'metadata.status.var.LINK.txPackets',
    rxSequenceLost: 'metadata.status.var.LINK.rxSequenceLost', rxDuplicates: 'metadata.status.var.LINK.rxDuplicates', protocolVersion: 'metadata.status.var.LINK.protocolVersion',
  },
}

const COMMON_DESCRIPTIONS: Record<string, string> = {
  id: 'metadata.status.common.id', count: 'metadata.status.common.count', current: 'metadata.status.common.current', voltage: 'metadata.status.common.voltage',
  temperature: 'metadata.status.common.temperature', rpm: 'metadata.status.common.rpm', status: 'metadata.status.common.status', source: 'metadata.status.common.source',
  receiveHz: 'metadata.status.common.receiveHz', frames: 'metadata.status.common.frames', instance: 'metadata.status.common.instance', units: 'metadata.status.common.units',
  x: 'metadata.status.common.x', y: 'metadata.status.common.y', z: 'metadata.status.common.z',
  vx: 'metadata.status.common.vx', vy: 'metadata.status.common.vy', vz: 'metadata.status.common.vz',
  roll: 'metadata.status.common.roll', pitch: 'metadata.status.common.pitch', yaw: 'metadata.status.common.yaw', rollRate: 'metadata.status.common.rollRate',
  pitchRate: 'metadata.status.common.pitchRate', yawRate: 'metadata.status.common.yawRate', speed: 'metadata.status.common.speed', direction: 'metadata.status.common.direction',
  verticalSpeed: 'metadata.status.common.verticalSpeed', humidity: 'metadata.status.common.humidity', failureFlags: 'metadata.status.common.failureFlags', errorCount: 'metadata.status.common.errorCount',
  connectionType: 'metadata.status.common.connectionType', info: 'metadata.status.common.info', health: 'metadata.status.common.health',
  fieldStrength: 'metadata.status.common.fieldStrength', port: 'metadata.status.common.port', isStale: 'metadata.status.common.isStale',
}

export function statusVariableDescription(groupName: string, variableName: string): string | null {
  const normalizedGroup = GROUP_ALIASES[groupName] ?? groupName.replace(/\d+$/, '')
  const exactKey = GROUP_DESCRIPTIONS[normalizedGroup]?.[variableName]
  if (exactKey) return t(exactKey)
  if (/^cellVoltage\d+$/.test(variableName)) return t('metadata.status.regex.cellVoltage')
  if (/^servo\d+$/.test(variableName)) return t('metadata.status.regex.servo')
  if (/^ch\d+$/.test(variableName)) return t('metadata.status.regex.ch')
  if (/^rpm\d+$/.test(variableName)) return t('metadata.status.regex.rpm')
  if (/^rpmSensor\d+$/.test(variableName)) return t('metadata.status.regex.rpmSensor')
  if (/^temperature\d+$/.test(variableName)) return t('metadata.status.regex.temperature')
  if (/^(x|y|z)(acc|gyro|mag)$/.test(variableName)) {
    const axis = variableName[0].toUpperCase()
    const kind = variableName.endsWith('acc') ? t('metadata.status.kind.acc') : variableName.endsWith('gyro') ? t('metadata.status.kind.gyro') : t('metadata.status.kind.mag')
    return t('metadata.status.regex.axisSensor', { axis, kind })
  }
  if (/^rotation/.test(variableName)) return t('metadata.status.regex.rotation')
  const commonKey = COMMON_DESCRIPTIONS[variableName]
  return commonKey ? t(commonKey) : null
}
