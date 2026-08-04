const GROUP_ALIASES: Record<string, string> = {
  VEHICLE: 'Vehicle',
  BATTERY0: 'Battery0',
  GPS: 'Gps',
  DISTANCESENSOR: 'DistanceSensor',
  ESTIMATORSTATUS: 'EstimatorStatus',
}

const GROUP_COMMENTS: Record<string, string> = {
  VEHICLE: '飞行器运动、姿态与飞行状态',
  BATTERY0: '主电池电压、电流与剩余电量',
  CLOCK: '地面站本地时间与 UTC 时间',
  DISTANCESENSOR: '测距传感器与各安装方向读数',
  ESCSTATUS0: '电调遥测与故障汇总',
  ESTIMATORSTATUS: '状态估计器健康与创新量',
  GENERATOR: '机载发电机运行状态',
  GPS: '主 GNSS 定位与信号质量',
  GPS2: '第二 GNSS 定位与信号质量',
  GPSAGGREGATE: '多 GNSS 综合健康状态',
  HYGROMETER: '湿度计环境数据',
  LOCALPOSITION: '本地坐标系位置与速度',
  LOCALPOSITIONSETPOINT: '本地位置与速度目标值',
  RPM: '转速通道与转速传感器',
  SETPOINT: '姿态与角速度目标值',
  TEMPERATURE: '飞控温度探头汇总',
  TERRAIN: '地形数据缓存状态',
  VIBRATION: '惯导振动与削波统计',
  WIND: '估算风向与风速',
  EFI: '发动机电喷系统状态',
  POSITION: '融合后的全局位置与速度',
  BAROMETER: '气压、高度与温度数据',
  OPTICALFLOW: '光流、角速度与测距数据',
  RCCHANNELS: '遥控器输入通道',
  SERVOOUTPUT: '舵机与电机输出通道',
  SYSTEM: '飞控传感器与飞行前检查',
  FIRMWARE: '飞控硬件和固件标识',
  LINK: 'MAVLink 链路吞吐与错误统计',
}

export function statusGroupDescription(groupName: string): string | null {
  const normalized = groupName.toUpperCase()
  if (/^IMU\d+$/.test(normalized)) return '惯导加速度、角速度与磁场数据'
  if (normalized.startsWith('COMPASS_')) return '对应 MAVLink 消息源的磁场数据'
  return GROUP_COMMENTS[normalized] ?? null
}

const GROUP_DESCRIPTIONS: Record<string, Record<string, string>> = {
  Vehicle: {
    airSpeed: '相对空气速度', altitudeAboveTerr: '距地形高度', altitudeAMSL: '海拔高度',
    altitudeRelative: '相对起飞点高度', climbRate: '垂直爬升速度', distanceToGCS: '距地面站距离',
    distanceToHome: '距返航点距离', distanceToNextWP: '距下一航点', flightDistance: '本次飞行里程',
    flightTime: '本次飞行时长', groundSpeed: '对地移动速度', heading: '机头真航向',
    headingFromGCS: '地面站至飞行器方位', headingFromHome: '返航点至飞行器方位',
    headingToHome: '飞行器至返航点方位', headingToNextWP: '下一航点方向', hobbs: '累计运行时间',
    imuTemp: '主惯导温度', missionItemIndex: '当前任务序号', pitch: '俯仰姿态角',
    pitchRate: '俯仰角速度', roll: '横滚姿态角', rollRate: '横滚角速度',
    throttlePct: '当前油门百分比', timeToHome: '预计返航耗时', yawRate: '偏航角速度',
    flightMode: '当前飞行模式', armed: '飞行器解锁状态', failsafe: '当前失效保护状态',
    systemStatus: 'MAVLink 系统状态',
  },
  Battery0: {
    batteryFunction: '电池供电用途', batteryType: '电池化学类型', chargeState: '充电与告警状态',
    current: '实时放电电流', id: '电池实例编号', instantPower: '实时输出功率',
    mahConsumed: '累计消耗容量', percentRemaining: '估算剩余电量', temperature: '电池温度',
    timeRemaining: '估算剩余时间', timeRemainingStr: '剩余时间文本', voltage: '电池总电压',
  },
  Clock: { currentDate: '本地当前日期', currentTime: '本地当前时间', currentUTCTime: 'UTC 当前时间' },
  Gps: {
    authenticationState: 'GNSS 认证状态', correctionsQuality: '差分改正质量', count: '可见卫星数量',
    courseOverGround: '对地航迹方向', gnssSignalQuality: '卫星信号质量', hdop: '水平精度因子',
    jammingState: '射频干扰状态', lat: '当前纬度', lock: '定位解算类型', lon: '当前经度',
    mgrs: '军用网格坐标', postProcessingQuality: '后处理定位质量', spoofingState: '欺骗检测状态',
    systemErrors: '接收机错误状态', systemQuality: '接收机综合质量', vdop: '垂直精度因子', yaw: '双天线航向',
    fixType: 'GPS 定位类型', altitudeMSL: 'GPS 海拔高度', eph: '水平位置误差',
    epv: '垂直位置误差', velocity: 'GPS 对地速度', satellitesVisible: '可见卫星数量',
  },
  EstimatorStatus: {
    accelError: '加速度融合异常', goodAttitudeEsimate: '姿态估计有效',
    goodConstPosModeEstimate: '定点模式估计有效', goodHorizPosAbsEstimate: '绝对水平位置有效',
    goodHorizPosRelEstimate: '相对水平位置有效', goodHorizVelEstimate: '水平速度估计有效',
    goodPredHorizPosAbsEstimate: '预测绝对位置有效', goodPredHorizPosRelEstimate: '预测相对位置有效',
    goodVertPosAbsEstimate: '绝对高度估计有效', goodVertPosAGLEstimate: '离地高度估计有效',
    goodVertVelEstimate: '垂直速度估计有效', gpsGlitch: 'GPS 数据跳变', haglRatio: '离地高度创新比',
    horizPosAccuracy: '水平位置精度', horizPosRatio: '水平位置创新比', magRatio: '磁场创新比',
    tasRatio: '真空速创新比', velRatio: '速度创新比', vertPosAccuracy: '垂直位置精度',
    vertPosRatio: '垂直位置创新比', healthFlags: '估计器健康位图', velInnovation: '速度创新量',
    posInnovation: '位置创新量', hgtInnovation: '高度创新量', magInnovation: '磁场创新量',
  },
  DistanceSensor: {
    currentDistance: '当前测得距离', minDistance: '传感器最小量程', maxDistance: '传感器最大量程',
    signalQuality: '测距信号质量', type: '测距传感器类型', id: '传感器实例编号', orientation: '传感器安装方向',
  },
  EscStatus: {
    connectionType: '电调遥测连接类型', count: '已报告电调数量', current: '电调总电流',
    errorCount: '电调累计错误数', failureFlags: '电调故障状态位图', id: '电调状态实例编号',
    info: '电调信息状态位图', rpm: '电调当前转速', temperature: '电调当前温度', voltage: '电调供电电压',
  },
  Generator: {
    batCurrentSetpoint: '电池充电电流目标', batteryCurrent: '发电机侧电池电流', busVoltage: '发电机母线电压',
    genSpeed: '发电机当前转速', genTemp: '发电机温度', loadCurrent: '发电机负载电流',
    powerGenerated: '当前发电功率', rectifierTemp: '整流器温度', runtime: '累计运行时间',
    status: '发电机状态位图', timeMaintenance: '距下次维护时间',
  },
  GpsAggregate: {
    authenticationState: '综合 GNSS 认证状态', isStale: 'GNSS 汇总数据已过期',
    jammingState: '综合射频干扰状态', spoofingState: '综合欺骗检测状态',
  },
  Hygrometer: { humidity: '相对湿度', hygrometerid: '湿度计实例编号', temperature: '湿度计温度' },
  Rpm: {
    rpm1: '第一路转速', rpm2: '第二路转速', rpm3: '第三路转速', rpm4: '第四路转速',
    rpmSensor1: '第一转速传感器读数', rpmSensor2: '第二转速传感器读数',
  },
  Temperature: { temperature1: '第一温度探头', temperature2: '第二温度探头', temperature3: '第三温度探头' },
  Terrain: { blocksLoaded: '已载入地形数据块', blocksPending: '待载入地形数据块' },
  Vibration: {
    clipCount1: '第一惯导削波次数', clipCount2: '第二惯导削波次数', clipCount3: '第三惯导削波次数',
    xAxis: 'X 轴振动强度', yAxis: 'Y 轴振动强度', zAxis: 'Z 轴振动强度',
  },
  Efi: {
    baroPress: '发动机气压', cylinderTemp: '气缸温度', ecuIndex: 'ECU 实例编号', engineLoad: '发动机负载',
    exGasTemp: '排气温度', fuelConsumed: '累计燃油消耗', fuelFlow: '实时燃油流量', fuelPressure: '燃油压力',
    health: '电喷系统健康状态', ignTime: '点火提前时间', ignVoltage: '点火系统电压', injTime: '喷油脉宽',
    intakePress: '进气歧管压力', intakeTemp: '进气温度', ptComp: '压力温度补偿', rpm: '发动机转速',
    sparkTime: '火花持续时间', throttleOut: 'ECU 油门输出', throttlePos: '节气门位置',
  },
  POSITION: {
    lat: '融合位置纬度', lon: '融合位置经度', alt: '融合海拔高度', relativeAlt: '相对起飞点高度',
    vx: '北向速度', vy: '东向速度', vz: '垂直向下速度', hdg: '融合航向',
  },
  BAROMETER: { pressAbs: '绝对气压', pressDiff: '差分气压', temperature: '气压计温度', altitude: '气压高度' },
  OPTICALFLOW: {
    quality: '光流跟踪质量', integratedX: 'X 轴积分光流', integratedY: 'Y 轴积分光流',
    integratedXGyro: 'X 轴积分角速度', integratedYGyro: 'Y 轴积分角速度',
    integratedZGyro: 'Z 轴积分角速度', distance: '光流测距高度', temperature: '光流模块温度',
  },
  SYSTEM: { sensorsHealthy: '传感器总体健康', preflightCheck: '飞行前检查结果', unhealthySensors: '异常传感器列表' },
  FIRMWARE: {
    boardName: '飞控板型号', boardId: '飞控板硬件编号', firmwareVersion: '固件语义版本',
    firmwareLabel: '固件完整标识', vendorId: 'USB 厂商编号', productId: 'USB 产品编号',
  },
  LINK: {
    rxBps: '链路接收速率', txBps: '链路发送速率', crcErrors: '累计 CRC 错误',
    crcErrorsPerSec: '每秒 CRC 错误', rxPackets: '累计接收包数', txPackets: '累计发送包数',
    rxSequenceLost: '接收序列丢包数', rxDuplicates: '重复接收包数', protocolVersion: 'MAVLink 协议版本',
  },
}

const COMMON_DESCRIPTIONS: Record<string, string> = {
  id: '设备或实例编号', count: '当前实例数量', current: '实时电流', voltage: '实时电压',
  temperature: '实时温度', rpm: '实时转速', status: '当前工作状态', source: '数据消息来源',
  receiveHz: '浏览器实测频率', frames: '累计接收帧数', instance: '消息实例编号', units: '数值单位体系',
  x: '局部坐标 X 分量', y: '局部坐标 Y 分量', z: '局部坐标 Z 分量',
  vx: 'X 轴速度分量', vy: 'Y 轴速度分量', vz: 'Z 轴速度分量',
  roll: '横滚角', pitch: '俯仰角', yaw: '偏航角', rollRate: '横滚角速度',
  pitchRate: '俯仰角速度', yawRate: '偏航角速度', speed: '水平速度', direction: '方向角',
  verticalSpeed: '垂直速度', humidity: '相对湿度', failureFlags: '故障状态位图', errorCount: '累计错误数',
  connectionType: '遥测连接类型', info: '设备信息状态位图', health: '设备健康状态',
  fieldStrength: '合成磁场强度', port: '输出端口编号', isStale: '数据已过期',
}

export function statusVariableDescription(groupName: string, variableName: string): string | null {
  const normalizedGroup = GROUP_ALIASES[groupName] ?? groupName.replace(/\d+$/, '')
  const exact = GROUP_DESCRIPTIONS[normalizedGroup]?.[variableName]
  if (exact) return exact
  if (/^cellVoltage\d+$/.test(variableName)) return '单节电芯电压'
  if (/^servo\d+$/.test(variableName)) return '舵机输出脉宽'
  if (/^ch\d+$/.test(variableName)) return '遥控通道脉宽'
  if (/^rpm\d+$/.test(variableName)) return '对应通道的实时转速'
  if (/^rpmSensor\d+$/.test(variableName)) return '对应转速传感器读数'
  if (/^temperature\d+$/.test(variableName)) return '对应温度探头读数'
  if (/^(x|y|z)(acc|gyro|mag)$/.test(variableName)) {
    const axis = variableName[0].toUpperCase()
    const kind = variableName.endsWith('acc') ? '加速度' : variableName.endsWith('gyro') ? '角速度' : '磁场强度'
    return `${axis} 轴${kind}`
  }
  if (/^rotation/.test(variableName)) return '对应安装方向的测距值'
  return COMMON_DESCRIPTIONS[variableName] ?? null
}
