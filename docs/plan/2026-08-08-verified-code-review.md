# OpenConfigurator 经核验代码问题清单

- 核验日期：2026-08-08
- 核验基线：`6c03827`
- 原始材料：桌面目录中的 `CODE-REVIEW.md`
- 核验范围：原报告的 5 个 H 项、56 个 M 项，以及 P2 清单中两个未在 M 项重复列出的主张
- 文档性质：修复排期依据，不是硬件在环（HIL）验证报告

## 1. 判定口径

本清单只把能够从当前代码、运行时入口和协议语义直接证明的问题列为“已确认”。其余主张分成两类：

- **条件性风险**：代码事实存在，但影响依赖威胁模型、异常设备、浏览器/驱动非标准行为或尚未验证的性能假设。
- **不成立/移除**：与当前入口校验、UI 状态机、Node.js API 或 MAVLink/Gamepad 规范冲突，不应进入修复排期。

严重度重新定义如下：

- **P0**：可在正常支持路径触发，可能导致核心硬件功能失败或安全关键状态失真，发版前应处理。
- **P1**：可达的可靠性、状态一致性、资源耗尽或明显用户误导问题。
- **P2**：低频边界、性能、可访问性、国际化、类型和维护性问题。
- **Policy**：需要产品先明确安全边界或行为契约，不能只凭代码审查决定。

## 2. 已确认问题

### P0

| 编号 | 来源 | 问题 | 证据与影响 | 修复要求 |
|---|---|---|---|---|
| V-P0-01 | H2 | 4-way/MSP 帧长探测在缓冲不完整时返回期望长度 | `fourWayFrameLength` 在 5 字节后即返回完整长度，`mspFrameLength` 在读到 size 后即返回；三个传输泵随后立即用短缓冲完成事务。多 data 事件响应会被截断并在解码时失败。现有 codec 测试固化了该行为。 | 探测器仅在 `buffered.length >= expectedLength` 时返回长度；传输泵增加完整性守卫；补跨多个 data 事件的回归测试。 |

### P1

| 编号 | 来源 | 问题 | 证据与影响 | 修复要求 |
|---|---|---|---|---|
| V-P1-01 | M4 | 生产环境无条件信任本机 5173 Origin | `isAllowedOrigin` 对回环地址的 5173 端口始终返回 true，没有开发/生产条件。打包运行时，本机其他 5173 页面可建立受信任浏览器连接。 | 仅开发模式允许 5173；打包桌面模式只允许实际后端 Origin。 |
| V-P1-02 | M9 | MSP 客户端不校验响应 command | `MspClient.request` 只检查 `isError`，未比较 `response.command` 与请求 command。迟到响应可能被错误消费。 | 命令不匹配时返回 `target_mismatch`，并补陈旧响应测试。 |
| V-P1-03 | M13 | direct 模式未使用具备单线回显处理的传输实现 | 生产 `direct` 分支构造 `ArduPilotRawTransport`，`DirectSerialTransport` 仅在测试中使用；两者对单线回显的假设不同。 | 统一 direct 生产实现和回显策略，并用真实直连链路确认。 |
| V-P1-04 | M17 | 下载文件大小没有服务端上限 | FTP `OpenFileRO` 和 DataFlash `LOG_ENTRY` 的 32 位尺寸可驱动长时间临时文件写入。异常或恶意飞控可能耗尽宿主磁盘。 | 设置产品级文件大小上限；创建 `.part` 前检查可用空间；超限返回结构化错误。 |
| V-P1-05 | M20 | transport 仍打开但 heartbeat 暂失时执行全量前端重置 | `transportOpen=true && vehicleReady=false` 会落入断连分支，清参数、身份、版本及多个会话 store。5 秒软心跳超时即可触发。 | 为“传输打开但目标暂未 ready”增加独立 stale 状态；只在传输关闭或目标明确替换时全量清理。 |
| V-P1-06 | M23 | 0V 被当作有效电池电压 | SYS_STATUS 回退只判断 `voltageBattery != null`，BATTERY_STATUS 健康只判断 `voltage == null`。无电池监测器的 0V 可显示为正常。 | 非有限值和 `<= 0` 统一归一为未知；增加无电池监测器测试。 |
| V-P1-07 | M26 | ESC 原始会话后电机测试安全确认可能保留 | `safetyConfirmed` 只随电机数量变化或切换面板重置；ESC 会话可保留相同参数和电机数量。 | 在 vehicleReady 恢复、目标变化和 ESC 会话结束时重置确认与测试激活状态。 |
| V-P1-08 | M27 | 参数批量导入缺少单条写入超时 | 导入状态机只等待匹配结果或错误；结果丢失但 WS 保持连接时，任务永久停在 `writing`。 | 每条写入设置明确超时，记录失败后继续；允许用户取消卡住的任务。 |
| V-P1-09 | M30 | RAW_IMU 被按标准单位再次换算 | 后端为 RAW_IMU 标记 `units: 'raw'`，SensorPage 仍无条件将加速度乘重力常数、角速度转成度每秒。 | 根据 `imu.units` 选择显示和单位；为 RAW 回退路径补测试。 |
| V-P1-10 | M36 | `PreArm: Healthy` 未被识别为成功 | 成功正则不包含 `healthy`，会把该文本作为未解决的 PreArm 状态。 | 增加 `healthy` 成功样本；优先采用明确失败关键词和结构化状态。 |
| V-P1-11 | M44 | 日志姿态模型的横滚符号与实时模型不一致 | 日志模型使用 `rotation.z = +roll`，共享实时转换使用 `z = -roll`。相同姿态会呈现相反横滚。 | 日志回放复用 `attitudeToModelRotation`，增加两种视图的一致性测试。 |

### P2

| 编号 | 来源 | 问题 | 修复要求 |
|---|---|---|---|
| V-P2-01 | M5 | `scan` 和 `debug-ports` 回环 GET 缺少 HTTP 级限流，且 debug 端点暴露完整串口标识。 | 添加每来源限流；生产环境关闭或收窄 debug 信息。 |
| V-P2-02 | M11 | 4-way 帧探测不跳过前置杂散字节。 | 在有界缓冲内寻找 `0x2E` 并重同步，补前置垃圾测试。 |
| V-P2-03 | M14 | `parameterValues` Map 无容量上限。 | 设置合理上限并记录丢弃诊断；确认非下载期 PARAM_VALUE 的广播策略。 |
| V-P2-04 | M21 | WebSocket JSON 解析和消息分发共用一个 catch，并统一标记为 Parse error。 | 分开记录解析错误与 handler 错误。 |
| V-P2-05 | M24 | 任意 `transportOpen` 快照都会关闭连接对话框。 | 只在 false→true 状态转换时自动关闭。 |
| V-P2-06 | M25/M51 | telemetry/sensor 使用 `data: any`，前端直接写入字段。 | 按 `msgType` 建立判别联合，并在边界归一化非有限/缺失值。 |
| V-P2-07 | M29 | 波形页断连后继续用旧值追加平线。 | 以连接和 staleness 门控采样，显示暂停/离线状态。 |
| V-P2-08 | M31 | 时长格式可能显示 `0m 60s`。 | 四舍五入后统一处理 60 秒进位。 |
| V-P2-09 | M33 | PID 非法输入静默删除草稿。 | 保留输入并显示校验错误。 |
| V-P2-10 | M34 | 英文界面使用中文顿号，接收机频道名硬编码英文。 | 通过 i18n 提供列表分隔符和频道标签。 |
| V-P2-11 | M35 | ArduPilot 参数未加载时显示 PX4 输出参数占位名。 | 按 vehicle family 生成占位名，未知栈使用中性标签。 |
| V-P2-12 | M37 | DataFlash 时间戳回退会产生非单调分析时间轴。 | 把时间回退识别为 boot 边界，分段或明确截断。 |
| V-P2-13 | M38 | `modeSamples` 和 `armedSamples` 无容量上限。 | 限制事件数量或压缩相邻同值状态。 |
| V-P2-14 | M40 | ULog 缺失/NaN 时间戳被转换为 0。 | 跳过无有效正时间戳的消息并记录计数。 |
| V-P2-15 | M42 | demo 遥测 interval 没有显式 stop，且写入共享 localStorage key。 | 返回清理函数；隔离 demo 存储命名空间。 |
| V-P2-16 | M45 | 终端可见文本不处理退格和部分 C0 控制字符。 | 实现退格语义并过滤不支持的控制字符。 |
| V-P2-17 | M46 | 日志姿态播放每个 RAF 都触发 React 状态更新，且 updater 内修改另一状态。 | 模型使用 ref 驱动；读数降频；把停止播放移出状态 updater。 |
| V-P2-18 | M47 | ConnectDialog 关闭图标按钮没有无障碍名称。 | 添加本地化 `aria-label`。 |
| V-P2-19 | M48 | 多处可见字符串未国际化。 | 把 Roll/Pitch/Yaw、Bootloader、Enabled/Disabled 等迁入语言包。 |
| V-P2-20 | M49 | 每次参数同步从 active 变为 inactive 都重新请求 DataFlash 列表。 | 按连接/目标记录已请求状态，仅在明确刷新时重列。 |
| V-P2-21 | M50 | StatusVariableBrowser 在 render/useMemo 中修改 ref。 | 将差异提交移到 effect，保持 render 纯函数。 |
| V-P2-22 | M54 | `as never`/窄元组断言掩盖 includes 类型问题。 | 使用显式类型守卫或 `some` 比较。 |

## 3. 条件性风险与待决策略

这些条目不能按原报告的确定语气描述。实施前应先明确产品策略或补可复现测试。

| 来源 | 经核验后的表述 | 建议处置 |
|---|---|---|
| H1 | 桌面模式信任同一用户下的本地回环进程，未设置额外应用级认证。代码事实成立，但是否属于漏洞取决于产品是否把本地进程纳入威胁模型。 | **Policy**：若需要抵御同用户恶意进程，为桌面会话增加不可从普通 WS 获取的启动秘密；不要把“日志隐藏端口”当作认证。 |
| H3 | 光标状态更新会重建传入新 `selectionGroups` 的姿态和速率图表；不是原报告声称的全部九个图表。 | 固定分组引用并做一次实例计数性能测试，再决定 P1/P2。 |
| M1 | 控制器租约可由持续有效操作续期。这是租约的常见语义，但没有公平抢占或最长持有时间。 | **Policy**：确定单控制器优先还是多客户端公平；ESC/校准 pin 不应被普通抢占。 |
| M2 | CalibrationManager 的同步入口缺少最外层异常边界；ESC `handleClientMessage` 已有内部 try/catch，因此原报告对 ESC 的描述不成立。 | 只为校准入口增加统一错误边界；不要依赖 `uncaughtException` 继续运行未知状态进程。 |
| M6 | 蓝牙地址解析依赖特定 BTHENUM 格式，但报告没有提供真实失败样本。 | 先收集 Windows 10/11、不同适配器的 pnpId fixture，再决定是否放宽正则。 |
| M8 | DirectSerialTransport 会重试所有非取消/断链错误，但该类当前不在生产 direct 路径。 | 与 V-P1-03 一并删除死实现或接入后按读/写命令区分重试。 |
| M10 | 写完成后若链路丢失，读回校验无法完成，结果只能是“未确认”；这不等同于已证明写失败或违反成功写必须校验的规则。 | 增加 `unknown_after_write` 结果，提示重新读取，避免自动重写。 |
| M12 | PX4 wait helper 的 abort 回调未自移除，但 AbortSignal 和会话生命周期均有界，不构成持续累积泄漏。 | 顺手改为 `{ once: true }`，按代码卫生处理。 |
| M15 | DataFlash 没有全文件 CRC 是真实完整性缺口；“串口半包直接成为短 LOG_DATA”不成立，因为 MAVLink 帧先经过长度和 CRC 校验。 | 仅把异常短语义块视为兼容性风险；研究可行的 DataFlash 完整性检查，不假设协议提供 CRC。 |
| M16 | 客户端路径会访问飞控远端文件系统，不是宿主路径穿越；宿主临时文件名已净化。是否允许浏览/删除日志目录外内容属于产品权限模型。 | **Policy**：明确“通用 FC 文件管理器”还是“仅日志浏览器”，再决定目录白名单。 |
| M19 | socket 非 OPEN 时发送返回 false，Gamepad arm/disarm 提示忽略该结果，确有误导；但跨重连排队安全命令可能造成延迟误执行。 | 修复 UI 反馈；安全命令 fail-closed，不做跨重连自动重放。 |
| M22 | 高频 store 每帧创建新对象是代码事实，但“明显性能灾难”需要组件订阅和设备频率剖析支持。 | 先用 React Profiler/消息率基准定位宽订阅，再做 5–10 Hz 展示层采样。 |
| M32 | 模式段宽度没有上限，但正常解析结果应受 duration 约束；主要与异常/多 boot 数据相关。 | 在修复时间轴后增加最终 clamp，保持 P2。 |
| M39 | 用首尾平均间隔估算 FFT 采样率对非均匀数据不稳；仅换成中位数仍不能解决非均匀 FFT。 | 检测间隔抖动和大间隙，必要时重采样或拒绝频谱分析。 |
| M41 | `CopyingBufferReader.read()` 确实分配副本，但是否能安全去掉取决于解析库对输入缓冲生命周期的契约。 | 用大 ULog 做内存基准，并确认库不会保留/修改视图后再优化。 |
| M43 | 当前按样本索引分桶，但保留了每个极值的真实时间戳，因此不会把时间轴伪造成均匀采样；非均匀采样下的视觉代表性仍可能下降。 | 作为图表质量优化，不作为正确性故障。 |
| M52 | `set_flight_mode` 不携带 family，理论上存在目标切换时旧 modeId 与新栈合法 id 冲突的 TOCTOU；当前 UI 通常从最新身份生成模式。 | 下一版 wire 协议携带 profile generation/family，服务端拒绝陈旧来源。 |
| M53 | 通用 `command` 当前受命令白名单、deny-list 和 capability gate 保护；报告描述的是未来忘记同步约束的维护风险。 | 用允许列表和测试消除未来回归，不按当前漏洞处理。 |
| M55 | encoder 不执行 `visibleIf/disabledIf` 是事实，但这些字段是否是服务端约束尚未在契约中明确。 | **Policy**：若元数据代表写入规则，服务端必须执行；若仅控制 UI，应在类型注释中明确。 |
| M56 | `EscSessionMode` 描述用户选择，`EscTransportKind` 描述实现，两者语义不同，token 不同本身不是缺陷。 | 保留显式映射并加穷举测试即可。 |
| P2-1 | signing replay 水位跨物理重连保留是刻意的防重放设计；换飞控时可能产生兼容性问题，但清水位会降低安全性。 | 绑定到可信设备身份或签名会话，而不是在普通 target 变化时直接清空。 |
| P2-2 | FTP/DataFlash writeChain 在磁盘显著慢于链路时可能积累 promise；“一次循环立即挂起数千个”并非所有路径的实际行为。 | 增加队列长度/写延迟指标和压力测试，再决定批量 flush。 |

## 4. 不成立，移出问题清单

| 来源 | 移除原因 |
|---|---|
| H4 | Gamepad 规范要求断开处理完成后把 `navigator.[[gamepads]][index]` 设为 null。当前代码每帧重新调用 `getGamepads()`，不会按规范永久取得 `connected:false` 的冻结对象并持续发送。检查 `connected` 可做防御，但原 P0 场景不能作为已确认缺陷。 |
| H5 | `parseClientMessage` 强制 message rate 七个字段全部存在、为整数、范围 1–20 且属于 `MESSAGE_RATE_OPTIONS`。任意高频和缺字段 `NaN` 无法到达 MavlinkBridge。 |
| M3 | Node.js Writable 的 `write()` 返回 false 表示当前 chunk 已被接收/缓冲，只要求暂停后续写入，不表示当前帧被丢弃。当前实现会等待 drain 并排队后续帧；写回调报错表示真实写失败，关闭串口是合理策略。 |
| M7 | 当前 WebSocketServer 没有异步 `verifyClient`。`handleUpgrade`、`clients.add(ws)` 和 connection 回调在同一同步调用链完成，不存在报告描述的检查后异步加入竞态。 |
| M18 | MAVLink 2 标准签名本来就是 `SHA-256` 截断为 48 位，不是 AES-CMAC。当前 `node-mavlink` 算法方向符合标准。 |
| M28 | `pendingWrite !== null` 时参数编辑、保存和导入入口均禁用，正常 UI 无法在第一条确认/超时前发起第二条写入，因此单 timer 不会被第二次 UI 写覆盖。 |

## 5. 修复顺序

1. 先修 V-P0-01，并为三种 ESC 传输补跨 data 事件分块测试。
2. 处理 V-P1-01、V-P1-02、V-P1-03，完成桌面 Origin 和 ESC 真实链路可靠性闭环。
3. 处理 V-P1-05、V-P1-07、V-P1-08，修复连接/安全确认/导入状态机。
4. 处理 V-P1-06、V-P1-09、V-P1-10、V-P1-11，消除用户可见的错误状态和错误姿态。
5. 对 H1、M1、M16、M55 先作产品决策，再进入代码修改。
6. 其余 P2 按同一子系统合并修复，避免形成跨前后端的大型变更。

每项修复应先增加能够暴露当前行为的回归测试。ESC、Gamepad、串口、Bluetooth、日志传输等硬件相关路径必须明确区分无硬件测试与 HIL 结论。

## 6. 当前验证基线

- `npm run typecheck`：通过。
- `npm run test:protocol`：单独运行通过。
- `npm run test:server`：146 项中 145 项通过；`MavlinkBridge.test.ts` 的一个 10ms 级进度计数断言在并行总套件中失败，单独运行该测试文件通过。该现象应作为测试时序易抖动单独跟踪，不与上述产品缺陷混为一谈。
- 本次核验未进行真实飞控、ESC、蓝牙或 Gamepad HIL 测试。

## 7. 原报告编辑性问题

- 摘要写 P2 共 30 项，实际 P2 编号列表有 33 项。
- P0 摘要列出 H1–H5，但“发版前必须”路线图只列了四项，漏掉 H3。

## 8. 修复状态（2026-08-08）

本清单第 2 节的全部已确认问题均已完成代码修复：`V-P0-01`、`V-P1-01` 至 `V-P1-11`、`V-P2-01` 至 `V-P2-22`。条件性风险和 Policy 项未被擅自按确定缺陷修改。

验证结果：

- `npm run typecheck`：通过。
- `npm run test:protocol`：通过。
- `npm run test:server`：157 项全部通过。
- `npm run build`：通过；仅保留 Vite 的大分块提示。
- `git diff --check`：通过。

硬件验证边界：本次没有连接真实飞控、ESC、蓝牙或 Gamepad。`V-P1-03` 已统一生产 direct 路径的单线回显处理并通过无硬件分片/回显测试，但真实 AM32 直连链路仍需 HIL 确认；其余涉及实际串口时序、飞控重启和物理状态的修复也不能由单元测试替代 HIL 结论。
- 总结把 useWebSocket 问题写成 M9/M10/M11，正文实际编号是 M19/M20/M21。
- P2 列表大量重复引用 M 项，同时另有两个独立问题，不能直接用章节数字推导不重复缺陷总数。

## 8. 协议与 API 核验参考

- [MAVLink 2 Message Signing](https://mavlink.io/en/guide/message_signing.html)：标准签名使用截断至 48 位的 SHA-256。
- [MAVLink LOG_DATA](https://mavlink.io/en/messages/common.html#LOG_DATA)：`count` 字段定义及零长度结束标记。
- [W3C Gamepad](https://www.w3.org/TR/gamepad/)：断开事件、`connected` 状态和 `getGamepads()` 槽位行为。
- [Node.js Writable.write](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback)：返回 false 表示应等待 drain，不表示当前 chunk 被拒绝。
