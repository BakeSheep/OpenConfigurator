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
│                 → LogTimeline / MetricChartGroup        │
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
- **`runAnalysis`**：单次流式遍历所有数据消息，分发给对应模块的 `consume`，最后调用 `finalize` 产出结果

### 客户端层

- **`UlogAnalysisClient`**：主线程侧代理，管理 Worker 生命周期、请求/响应匹配、AbortSignal 取消、进度回调
- **`workerProtocol`**：类型化的请求/响应协议（`load` / `get_series` / `cancel` / `dispose`）
- **`SeriesCache`**：有界 LRU 缓存，最多 24 个查询结果或 32MB，原始数据浏览时避免重复计算

## 六个分析分区

| 分区 ID | 名称 | 说明 |
|---------|------|------|
| `overview` | 概览 | 飞行时长、固件、机型、解锁时间、模式变更、总体发现 |
| `control` | 控制 | 姿态/角速率跟踪误差、执行器输出与饱和率 |
| `estimator` | 估计器 | EKF 创新序列、融合状态、预警 |
| `sensors-power` | 传感器与动力 | IMU 频谱、电池电压/电流、ESC 温度、推进效率 |
| `navigation` | 导航 | GPS 精度、高度对比、速度、位移轨迹 |
| `events-raw` | 事件与原始数据 | 系统事件日志、Failsafe 状态、CPU 负载、原始 topic 浏览器 |

## 分析模块清单

| 模块 ID | 分区 | 首选 Topic | 别名 | 必需字段 | 机型适用 |
|---------|------|-----------|------|---------|---------|
| `flight-overview` | overview | `vehicle_status` | — | 全部可选 | 全机型 |
| `control-tracking` | control | `vehicle_attitude` | `vehicle_attitude_setpoint`, `vehicle_angular_velocity`, `vehicle_rates_setpoint` | attitude 必需 | 全机型 |
| `actuators` | control | `actuator_motors` | `actuator_outputs`, `actuator_servos`, `vehicle_control_mode` | 全部可选 | 全机型 |
| `estimator` | estimator | `estimator_status` | `ekf2_innovations`, `estimator_innovation`, `estimator_visual_innovation`, `sensor_preflow` | 全部可选，multi_id | 全机型 |
| `sensors` | sensors-power | `sensor_combined` | `sensor_accel`, `sensor_gyro`, `sensor_mag`, `sensor_baro` | 全部可选，multi_id | 全机型 |
| `power` | sensors-power | `battery_status` | `battery_status_old`, `system_power` | 全部可选，multi_id | 全机型 |
| `propulsion` | sensors-power | `esc_status` | `esc_0` | 全部可选，multi_id | 多旋翼/固定翼 |
| `navigation` | navigation | `vehicle_gps_position` | `gps`, `vehicle_global_position`, `vehicle_local_position`, `vehicle_air_data` | 全部可选，multi_id | 全机型 |
| `failsafe` | events-raw | `failsafe` | `vehicle_status`, `vehicle_land_detected` | 全部可选 | 全机型 |
| `system-health` | events-raw | `cpuload` | `system_power`, `vehicle_magnetometer` | 全部可选 | 全机型 |
| `events` | events-raw | `event` | — | 全部可选 | 全机型（PX4 ≥ 1.15） |

> 另有 `battery` 和 `gps` 辅助模块，分别为 `power` 和 `navigation` 提供补充指标。

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

- 图表序列默认限制 **5000 点**（`pointBudget`），超出时采用 min/max 降采样保留峰值
- `SeriesCache` 限制最多 **24 个查询 / 32MB**，超出时淘汰最久未使用的条目
- 事件列表最多显示 500 条

## CSV 导出

原始浏览器支持 CSV 导出，受 `pointBudget` 约束，流式生成避免大文件内存溢出。

## 已知限制

- 不支持加密的 ULog 文件
- 不支持 v2 中除 `AppendedData` 以外的不兼容标志位
- 结构化事件 (`event` topic) 仅在 PX4 ≥ 1.15 的日志中可用
- `esc_status` 推进分析依赖 ESC 实际上报数据，部分硬件不记录此 topic
- 轨迹地图需要 GPS 定位（fix_type ≥ 2），纯室内飞行无 GPS 时不可用
- 不分析 `task_stack_info` 的线程级堆栈细节

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
         chartSeries: [],
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
