# ULog 日志分析

## 概述

OpenConfigurator 内置 PX4 ULog 飞行日志的结构化分析功能。所有解析和分析均在浏览器本地完成，**不会上传任何日志数据到外部服务器**。

支持三种日志来源：
- 本地 `.ulg` 文件（拖放或文件选择器）
- 飞行日志页面下载后转分析
- 已连接飞控直接导入（FTP 下载 → 分析）

## 支持的 ULog 版本

| 版本 | 支持情况 |
|------|---------|
| v1 | 完整支持 |
| v2（含追加崩溃数据） | 完整支持，自动归一化 |
| v2（未知不兼容标志位） | 拒绝并报错 |

## 架构

```text
┌─────────────────────────────────────────────────────────┐
│ UI Layer (React)                                        │
│ LogAnalysisPage → AnalysisSectionNav / AnalysisGroup    │
│                 → HealthSummary / FindingsList          │
│                 → LogTimeline / SectionChartWorkspace   │
│                 → RawTopicExplorer / TrackMap           │
├─────────────────────────────────────────────────────────┤
│ Client Layer                                           │
│ UlogAnalysisClient ←→ typed worker protocol             │
│ SeriesCache (LRU, 24 queries / 32MB)                   │
├─────────────────────────────────────────────────────────┤
│ Web Worker (ulogAnalysisWorker.ts)                     │
│ ModuleRegistry → runAnalysis → SectionResult[]          │
├─────────────────────────────────────────────────────────┤
│ Engine Layer                                            │
│ AnalysisModule interface · topicResolver · runAnalysis  │
├─────────────────────────────────────────────────────────┤
│ Parser Layer                                            │
│ normalizeUlogBuffer → UlogDocument (catalog, metadata)  │
│ fieldPaths (expand, isNumeric)                          │
├─────────────────────────────────────────────────────────┤
│ @foxglove/ulog                                          │
└─────────────────────────────────────────────────────────┘
```

### 解析层

- **`normalizeUlogBuffer`**：校验 magic、版本、FlagBits；检测 v2 追加数据段并归一化为连续数据流；修复截断尾部
- **`UlogDocument`**：持有一个完整的解析后文档——元信息、参数、完整 catalog（每个 topic 实例的所有字段）、事件、时间线摘要、覆盖率统计
- **`fieldPaths`**：将 ULog 字段定义展开为叶子路径（标量、数组、嵌套结构体），判断可绘图性

### 引擎层

- **`AnalysisModule`** 接口：`id`、`section`、`requirements`（含别名）、`create`/`consume`/`finalize`
- **`topicResolver`**：按别名顺序匹配 topic，支持 multi_id 多实例
- **`moduleRegistry`**：注册表，按 section 查询
- **`runAnalysis`**：单次流式遍历所有数据消息，分发给对应模块的 `consume`，最后调用 `finalize` 产出结果。合并分区时保留每个模块的身份（`SectionResult.moduleResults[]`），图表以有序 `chartFamilies` 拼接，不再拉平

### PX4 语义适配层（`px4/`）

- **`flightState`**：解锁状态仅来自真实字段，优先级 `vehicle_status.arming_state`（1=DISARMED，2=ARMED）> `actuator_armed.armed` > 旧版/自定义 `armed` 字段（仅当字段存在）。缺失字段返回 `null`，绝不强制当作未解锁
- **`actuatorLayout`**：`actuator_motors.control[12]` 中未使用槽位永为 NaN（官方规范）。电机数量推断优先级：① `CA_ROTOR_COUNT`（1–12）→ ② 输出函数参数（`*_FUNCₙ = 101…112` 即 Motor 1–12）→ ③ 解锁期间有限值的通道（标记为推断）→ ④ 任意时刻有限值的通道。全 NaN 槽位不产生指标/曲线/发现。无效缺口仅在“已配置 + 曾有数据 + 解锁期间 + 持续超阈”时才报告；短缺口为 notice，持续缺口为 warning，`critical` 仅留给有独立故障/ESC 证据的实测损失。用户可见电机编号一律 1 基（电机 1…N），内部索引保持 0 基
- **`sensorProfiles`**：图表字段按语义档案选择，绝不取“前三个数值字段”。`sensor_combined` 是校准后的主 IMU 概要（`accelerometer_m_s2[0..2]`、`gyro_rad[0..2]`，削波位域 bit0=X/bit1=Y/bit2=Z）；专用 topic（`sensor_accel`/`sensor_gyro`/`sensor_mag`/`sensor_baro`/`vehicle_air_data`）作为可选实例视图，支持新旧字段名（`x/y/z` 优先，回退 `xyz[]`/`magnetometer_ga[]`）

### 客户端层

- **`UlogAnalysisClient`**：主线程侧代理，管理 Worker 生命周期、请求/响应匹配、AbortSignal 取消、进度回调
- **`workerProtocol`**：类型化的请求/响应协议（`load` / `get_series` / `cancel` / `dispose`）
- **`SeriesCache`**：有界 LRU 缓存，最多 24 个查询结果或 32MB，原始数据浏览时避免重复计算

## 六个分析分区

| 分区 ID | 名称 | 说明 |
|---------|------|------|
| `overview` | 概览 | 飞行时长、固件、机型、解锁时间、模式变更、总体发现（无自动图表墙） |
| `control` | 控制 | 控制跟踪（姿态/角速度按轴“实际+设定”视图）与执行器（电机输出） |
| `estimator` | 估计器 | 新息检验比、状态协方差、故障/航位推算/重置发现（按实例视图） |
| `sensors-power` | 传感器与动力 | 惯性传感器、振动频谱、磁场与气压、电池、电调与推进 |
| `navigation` | 导航 | GPS 质量（定位类型/精度）、风速估计 |
| `events-raw` | 事件与原始数据 | 系统事件日志、Failsafe 状态、系统资源、原始 topic 浏览器 |

## 图表族导航（单一工作区）

每个活动分区只挂载 **一个** `SectionChartWorkspace`：

- `SectionResult.chartFamilies` 按 `order` 有序，每个族携带自己的 `views`、`defaultViewId` 与来源 `moduleId`；
- 工作区提供两级文字选择器（图表族 → 视图），任意时刻只有选中的 `ChartView` 挂载 uPlot；
- 默认可见曲线由 `ChartView.defaultVisibleSeriesIds` 声明：姿态/角速度视图默认“实际+设定”一对；加速度/角速度/磁场默认 X+Y+Z；电机输出在 ≤6 台时默认全部可见；
- 指标与诊断发现始终与图表同时可见（紧凑指标条 + 发现列表），不会被互斥渲染条件隐藏。

各分区图表族上限（选择器数量，非同时渲染的图表数）：控制 ≤2，估计器 ≤3，传感器与动力 ≤5，导航 ≤4（由 `chartFamilies.test.ts` 回归验证）。

## 分析模块清单

| 模块 ID | 分区 | 首选 Topic | 别名 | 必需字段 | 机型适用 |
|---------|------|-----------|------|---------|---------|
| `flight-overview` | overview | `vehicle_status` | `actuator_armed`、`vehicle_land_detected`、`commander_state` | 全部可选 | 全机型 |
| `control-tracking` | control | `vehicle_attitude` | `vehicle_attitude_setpoint`, `vehicle_angular_velocity`, `vehicle_rates_setpoint`, `vehicle_status`, `actuator_armed` | attitude 必需 | 全机型 |
| `actuators` | control | `actuator_motors` | `actuator_outputs`, `actuator_servos`, `vehicle_status`, `actuator_armed`, `vehicle_control_mode` | 全部可选 | 全机型 |
| `estimator` | estimator | `estimator_status` | `ekf2_innovations`, `estimator_innovation`, `estimator_visual_innovation`, `sensor_preflow` | 全部可选，multi_id | 全机型 |
| `sensors` | sensors-power | `sensor_combined` | `sensor_accel`, `sensor_gyro`, `sensor_mag`, `sensor_baro`, `vehicle_air_data` | 全部可选，multi_id | 全机型 |
| `power` | sensors-power | `battery_status` | `battery_status_old`, `system_power` | 全部可选，multi_id | 全机型 |
| `propulsion` | sensors-power | `esc_status` | — | 全部可选，multi_id | 多旋翼/固定翼 |
| `navigation` | navigation | `vehicle_gps_position` | `sensor_gps`, `vehicle_global_position`, `vehicle_local_position`, `vehicle_air_data`, `wind` | 全部可选，multi_id | 全机型 |
| `failsafe` | events-raw | `failsafe` | `vehicle_status`, `vehicle_land_detected` | 全部可选 | 全机型 |
| `system-health` | events-raw | `cpuload` | `system_power`, `vehicle_magnetometer` | 全部可选 | 全机型 |
| `events` | events-raw | `event` | — | 全部可选 | 全机型（PX4 ≥ 1.15） |

> 模块↔字段的完整审计表（含单位、缺失数据行为、置信度）见 `chartFamilies.test.ts` 中的 `FIELD_AUDIT`，别名与模块代码不一致时测试会失败。

### 解锁状态来源（State Provenance）

所有涉及解锁区间的模块（概览、控制跟踪、执行器）统一通过 `px4/flightState.readArmedState` 读取：`vehicle_status.arming_state === 2` 开启解锁区间，`=== 1` 关闭；`actuator_armed.armed` 作为回退；不存在任何对 `vehicle_status.armed` 这种虚构字段的依赖。无状态 topic 时，控制跟踪使用“存在设定值即视为解锁”的启发式，且一旦出现真实状态样本会丢弃启发式区间。

## Catalog 与通用原始浏览器

除了专用分析模块外，`UlogDocument` 构建的 **完整 catalog** 列出日志中每个 topic 实例的所有字段。`RawTopicExplorer` 组件允许用户选择任意 topic 实例和字段，通过 `get_series` 协议向 Worker 请求原始时序数据，经 `SeriesCache` 缓存后渲染为图表。

这意味着即使某个新 topic 没有被任何分析模块消费，用户仍然可以通过原始浏览器查看其数据——**前向兼容**。

## 多实例 (multi_id) 处理

PX4 允许同一 topic 存在多个实例（如多 IMU：`sensor_accel` multi_id 0/1/2）。分析引擎的 `TopicRequirement` 支持 `multiInstance: true` 标记，`topicResolver` 会匹配所有实例。catalog 中每个实例独立列出，覆盖率统计精确到实例级别。

## 追加数据 (Appended Data)

PX4 v2 ULog 可能在正常数据段之后追加崩溃前最后记录的数据。`normalizeUlogBuffer` 会：

1. 检测 FlagBits 记录中的 `AppendedData` 不兼容标志位
2. 读取追加段偏移量
3. 将追加数据段拼接到主数据流
4. 标记 `hadAppendedData: true`

下游模块和 catalog 看到的是归一化后的连续数据流，无需感知追加段的存在。

## 置信度等级

| 等级 | 含义 |
|------|------|
| `measured` | 直接来自传感器原始测量值（如电池电压、GPS 卫星数） |
| `derived` | 通过计算得出（如姿态误差 = 设定值 − 实际值、振动 RMS） |
| `heuristic` | 基于经验阈值判断（如 "电压低于 3.5V/节 → 警告"） |

## 阈值与降采样

- 所有图表序列采用 **全日志有界降采样**：模块内使用 `StreamingSeriesCollector`（自适应步长 min/max 包络）或全量步进降采样，覆盖完整时间范围并保留首尾点与极值；**绝不仅保留前 N 个样本**
- 无效/缺失值以 NaN 缺口保留，图表断线而非补零
- 原始浏览器查询默认限制 **5000 点**（`pointBudget`），超出时采用 min/max 降采样保留峰值
- `SeriesCache` 限制最多 **24 个查询 / 32MB**，超出时淘汰最久未使用的条目
- 事件列表最多显示 500 条

## CSV 导出

原始浏览器支持 CSV 导出，受 `pointBudget` 约束，流式生成避免大文件内存溢出。

## 已知限制

- 不支持加密的 ULog 文件
- 不支持 v2 中除 `AppendedData` 以外的不兼容标志位
- 结构化事件 (`event` topic) 仅在 PX4 ≥ 1.15 的日志中可用
- `esc_status` 推进分析依赖 ESC 实际上报数据，部分硬件不记录此 topic；电机平均转速不均衡为指标汇总，不伪装成时序图
- 风速估计需要 `wind` topic 的 `windspeed_north/east` 字段；位置/速度/高度对比、空速/光流/测距的图表视图尚未实现（数据可在原始浏览器中查看）
- 轨迹地图需要 GPS 定位（fix_type ≥ 2），纯室内飞行无 GPS 时不可用
- 不分析 `task_stack_info` 的线程级堆栈细节
- 基于阈值的结论（如饱和、偏置、压降）标记为 `heuristic`，不升级为实测结论

## 如何添加分析模块

1. 在 `src/web/log-analysis/modules/` 下创建新文件，如 `myModule.ts`
2. 实现 `AnalysisModule` 接口：
   ```ts
   export const myModule: AnalysisModule<MyState, MyResult> = {
     id: 'my-module',
     section: 'sensors-power', // 目标分区
     requirements: [
       {
         aliases: ['my_topic', 'my_topic_legacy'],
         required: false,
         bindAs: 'myTopic',
         multiInstance: true, // 可选
       },
     ],
     create(context) { return { /* 初始状态 */ } },
     consume(state, sample, bindName) { /* 处理每个样本 */ },
     finalize(state, context) {
       return {
         chartFamilies: [], // 按“图表族 → 视图 → 系列”组织，不要每个字段一张图
         metrics: {},
         findings: [],
         consumedTopics: [],
         missingRequirements: [],
         warnings: [],
         result: state,
       }
     },
   }
   ```
3. 在 `src/web/workers/ulogAnalysisWorker.ts` 的 `createRegistry()` 中注册
4. 在 `src/web/log-analysis/realLogs.test.ts` 的 `createFullRegistry()` 中同步注册
5. 编写单元测试验证模块逻辑
6. 更新本文档的模块清单

## 覆盖附录

兼容性矩阵（由 `realLogs.test.ts` 验证）：

| 日志类型 | 解析 | Catalog | 模块分析 | 覆盖率不变量 |
|---------|------|---------|---------|-------------|
| 基础多旋翼 | ✅ | ✅ | ✅ | ✅ |
| 固定翼（含空速） | ✅ | ✅ | ✅ | ✅ |
| 旧版 topic 名称 | ✅ | ✅ | ✅（别名解析） | ✅ |
| 多 IMU 实例 | ✅ | ✅ | ✅（multi_id） | ✅ |
| 参数变更 + 丢包 | ✅ | ✅ | ✅ | ✅ |
| v2 追加崩溃数据 | ✅ | ✅ | ✅ | ✅ |
| 损坏 magic | ❌ 拒绝 | — | — | — |
| 缓冲区过小 | ❌ 拒绝 | — | — | — |
| 不支持版本 | ❌ 拒绝 | — | — | — |
| 未知不兼容标志 | ❌ 拒绝 | — | — | — |
| 确定性（重复运行） | ✅ | ✅ | ✅ | ✅ |
