# QGC 配置行为与参数来源

OpenConfigurator 的飞行器设置以 QGroundControl 提交
`f4d5cb0bc975294b51d050fc8878e5600e93b907` 为行为核对基线，但使用本项目自己的
React、Zustand、本地 Worker 协议和视觉组件实现。项目不运行 QML，不引入 QGC 表达式
解释器，也不把 QGC 控制器代码移植到 Worker。

## 固定来源

| 功能 | QGroundControl 来源 | 本项目用途 |
| --- | --- | --- |
| PX4 机架 | `src/AutoPilotPlugins/PX4/AirframeFactMetaData.xml`、`AirframeComponentController.cc` | 生成机架分组、名称、autostart ID 与输出描述；核对应用和重启顺序 |
| 遥控器校准 | `src/AutoPilotPlugins/Common/RadioComponentController.cc` | 核对 1000–2000 默认端点、1500 中点、300 PWM 动作阈值、20 PWM 稳定阈值与 1300/1700 有效端点 |
| PX4 飞行模式 | `src/AutoPilotPlugins/PX4/PX4FlightModes.qml` | 核对六档模式、通道映射与专用开关语义 |
| ArduPilot 飞行模式 | `src/AutoPilotPlugins/APM/APMFlightModesComponent.qml` | 核对六档 PWM 分段、Simple/Super Simple 与辅助通道选项 |

固定版本的 PX4 机架目录可用 `npm run generate:px4-airframes` 重新生成。生成器验证 XML
结构并把来源提交写入生成文件；目录数据采用 QGroundControl 提供的 Apache License 2.0
双许可选项，详见根目录 `THIRD_PARTY_NOTICES.md`。

## 协议与安全语义

安全设置不会按枚举数值大小猜测“更安全”的动作。动作、返航/着陆策略和 failsafe
bitmask 的任何变化都要求显式确认；电池阈值、失联超时、EKF 阈值等只有在明确的风险
方向上变化时才视为保护弱化。前端提示与 Worker 抢占控制权前的预检共用
`isSafetyReduction()`，避免绕过或两端判断不一致。

- `vehicle_config_set` 只接受固件 profile 声明的字段，参数类型从 Worker 的已验证参数缓存取得，不信任浏览器输入。
- 单参数写入等待名称与值都匹配的 `PARAM_VALUE` 回读。机架与遥控器多参数流程顺序执行，失败即停止并尽力回滚已经确认的项目。
- 新写入要求飞控已就绪、控制者租约、受支持 profile、明确上锁、参数存在且没有 ESC 或传感器校准等冲突会话。
- 降低失控保护或关闭全部解锁检查时，浏览器和 Worker 都要求 `reduce_failsafe_protection` 明示确认。
- `COMMAND_ACK` 只表示命令处理结果；重启、上锁状态和其他物理状态仍由对应遥测变化确认。

## 固件参数边界

- PX4：机架使用 `SYS_AUTOSTART`/`SYS_AUTOCONFIG`；遥控器使用 `RC_MAP_*`、`RCx_MIN/MAX/TRIM/REV`；模式、电池和安全字段仅在飞控真实发布对应参数时显示。
- ArduCopter：机架使用 `FRAME_CLASS`/`FRAME_TYPE`；遥控器使用 `RCMAP_*` 与固件实际存在的 `RCx_REVERSED` 或 `RCx_REV`；模式、电池和安全字段同样按参数存在性展示。
- 未知枚举值始终作为当前值保留，不会因目录缺失而被静默改写。
- ArduPlane、Rover、Sub、Tracker 和未识别固件保持只读，不通过参数名猜测固件栈。

## 本期不包含

相机/云台、围栏、避障、PX4 ESC PWM 校准、UAVCAN 执行器分配，以及
ArduPlane/Rover/Sub 写入不在本期配置功能内。软件与自动化测试通过不等于 HIL 或实机
验证；在拆桨完成 PX4、ArduCopter 和多电池台架验证前，兼容性仅标记为“软件支持”。
