# OpenConfigurator 后端安全审查（核实与去误报版）

> 核查日期：2026-08-14  
> 核查基线：`2507218`（`Merge origin/main into main`）  
> 范围：`src/server/`、相关 `src/shared/` 协议与车辆配置代码  
> 方法：合并三份既有审查，逐项对照当前实现；运行 `npm run test:protocol`。未进行串口攻击复现、飞控 HIL 或 ESC 台架验证。

## 1. 结论摘要

本报告只把代码事实成立、攻击或故障链基本闭合的问题列为“已确认”。原报告中不成立的结论已删除；部分成立的问题已改写影响和严重度。物理后果依赖飞控、ESC、操作系统或具体硬件的项目，单列为“待验证”，不得当作已复现事故。

已确认问题共 16 项：

| 等级 | 数量 | 核心主题 |
| --- | ---: | --- |
| High | 4 | 连接控制与端口授权、泛参数写安全绕过、PX4 armed 状态进入 ESC、ESC 写失败后的未知设备状态 |
| Medium | 6 | FTP 递归路径逃逸、日志请求长度截断、流式操作取消/进展判定、ESC RX 上限、ESC 与其他链路任务互斥、参数类型缓存无界 |
| Low | 6 | 设备指纹暴露、主机路径泄露、Radio 写入生命周期、dev Origin、签名策略/未来时间戳、临时文件与帧重同步等加固项 |

建议优先级：

1. 先封闭 `param_set` 和 REST/串口授权边界。
2. 补齐 PX4 ESC armed gate，并让 ESC 写失败进入“状态未知、停止批次、恢复设备”流程。
3. 修复 FTP 路径包含、日志 uint16 截断和所有无进展流式接收。
4. 最后处理信息泄露、缓存上限、远程认证体验和协议加固。

## 2. 已确认漏洞

### H1. 连接控制在空租约时放行，且串口路径未绑定枚举结果

**位置**

- `src/server/index.ts:753-807`：空租约自动授予控制权。
- `src/server/index.ts:891-907`：`controllerLease` 为空时 REST connect/disconnect 无条件放行。
- `src/server/index.ts:1434-1459`：连接控制端点。
- `src/server/index.ts:1678-1707`：direct ESC 消息先于通用 ready-target gate。
- `src/server/validation.ts:1009-1028`：`port` 只限制为可打印字符。
- `src/server/connection/ConnectionManager.ts:255-273`：新 connect 会 teardown 当前链路。

**核实后的描述**

默认服务只监听 loopback，远程模式另有全局 token；因此这不是任意互联网远程攻击。攻击者必须是本机进程，或运行在允许 Origin 上的页面。

在没有现存租约时，调用者可以直接调用 REST connect/disconnect。调用者也可以发送最终会失败的 mutating WS 消息取得 30 秒租约；业务前置条件失败不会回滚这次新授予的普通租约。拿到自己 `hello` 中的 `restControlToken` 后，可以要求连接任意可打印路径。新 connect 会关闭现有连接。

该链路不能直接抢占尚未过期、由其他客户端持有的租约；原报告中的“任意抢占”表述过强。`restControlToken` 也是按客户端单播，不是广播给所有客户端。

**影响**

- 未授权替换或断开当前飞控连接。
- 在浏览器未经过 Web Serial chooser 的情况下请求后端打开其他串口/设备路径。
- 触发连接安全边界变化，干扰合法操作。

**修复建议**

1. REST connect/disconnect 始终要求属于某个活动 WS 客户端的 control token；不得以“当前无租约”为免鉴权条件。
2. connect 前要求客户端持有控制租约；若产品需要首次连接，可增加显式 `connection_control_claim`，而不是让任意 mutating 消息隐式取得权限。
3. 端口必须来自近期 `scanPorts()` 结果，并使用服务端生成的短期 opaque port id；不要信任客户端回传的原始路径。
4. 对替换活动连接增加绑定 `connectionGeneration`/fingerprint 的确认，服务器提交时再次核对。
5. 若前置条件失败且租约是本请求刚创建的，立即回滚；不要回滚调用者原先已持有的租约。

**必要测试**

- 无租约、无 token 的 connect/disconnect 返回 401/409。
- 失败的 direct ESC start 不创建或续期新租约。
- 非扫描端口、过期 port id、篡改后的端口标识均被拒绝。
- 替换连接必须匹配预期 generation；并发连接变化后旧确认失效。

### H2. `param_set` 绕过安全参数确认与配置白名单

**位置**

- `src/server/mavlink/MavlinkBridge.ts:2288-2294`
- `src/server/mavlink/MavlinkBridge.ts:3116-3188`
- 对照：`src/server/mavlink/MavlinkBridge.ts:2890-2938`
- 安全判定：`src/shared/vehicleSetupProfiles.ts:133-184`

**核实后的描述**

通用 `param_set` 只要求 ready target、可写 vehicle profile，并验证参数 ID、数值和 MAV_PARAM_TYPE。它不执行：

- `vehicle_config_set` 的参数白名单；
- 枚举值校验和字段约束；
- `isSafetyReduction()`；
- `reduce_failsafe_protection` 确认；
- safety authority/epoch；
- `airframe_apply` 的专用确认与事务流程。

因此持租约客户端可直接写入 `ARMING_CHECK`、failsafe 参数或 `SYS_AUTOSTART` 等，绕过项目已有安全模型。

**修复建议**

1. 最安全方案是把面向客户端的通用 `param_set` 改为只读工具内部使用，UI 写操作全部走 feature-scoped API。
2. 若必须保留通用写：建立服务端参数策略表，至少分类为 `ordinary`、`safety_relevant`、`airframe_only`、`blocked`。
3. `safety_relevant` 写入必须携带显式确认和当前 safety authority/epoch，并在 bridge 提交时再次校验。
4. `airframe_only` 参数拒绝通过通用通道写入。
5. 使用服务端参数缓存中的实际类型，不接受客户端任意指定 `paramType` 覆盖已知类型。

**必要测试**

- `ARMING_CHECK` 降低、已知 failsafe policy 变化在无确认时失败，且不取得/续期租约。
- 旧 epoch、错误 authority、目标切换后的请求失败。
- `SYS_AUTOSTART` 通过通用 `param_set` 被拒绝。
- 普通非安全参数仍按产品决策正常工作。

### H3. PX4 ESC 会话缺少 armed 状态前置条件

**位置**

- `src/server/esc/EscService.ts:188-243`
- `src/server/esc/EscService.ts:123-125`
- `src/server/esc/Px4SerialControlTransport.ts:98-170`
- 对照：`src/server/esc/ArduPilotRawTransport.ts:84-101`

**核实后的描述**

ArduPilot raw passthrough 在 transport open 时要求 `armedState === false`。PX4 transport 虽支持 `preflight()` 钩子，但当前 factory 没有传入，`EscService.handleStart()` 也没有统一检查 armed 状态。因此已解锁 PX4 目标仍可能启动 `SERIAL_CONTROL` ESC 会话。

报告中“必然导致空中电机停止或炸机”未经 HIL 证实，不作为既成事实；但在 armed 状态改变串口独占和 ESC 通道本身违反硬件安全边界，High 合理。

**修复建议**

1. 在 `EscService.handleStart()` 对所有 MAVLink-backed 模式统一要求 fresh `armedState === false`。
2. direct 模式无飞控心跳，应继续依赖 props removed、持续供电确认和明确的物理连接模式。
3. ESC 会话期间监听 armed、target、identity、ready 和连接 generation；任一边界变化立即停止新事务并安全退出。
4. bridge/transport 的 preflight 再做一次 commit-time 检查，避免检查与独占请求之间的 TOCTOU。

**必要测试**

- PX4 armed/unknown 状态拒绝 start，disarmed 状态允许。
- preflight 后、首次 `SERIAL_CONTROL` 前发生 armed 变化时拒绝写入。
- 会话期间 armed 变化触发终止，且不再向 ESC 发送后续帧。

### H4. ESC 写超时后设备状态未知，但批次继续下一目标

**位置**

- `src/server/esc/EscService.ts:376-436`
- `src/server/esc/Am32SettingsService.ts:130-192`
- `src/server/esc/EscDetector.ts:159-178`

**核实后的描述**

成功写入后确实会完整读回比较；原报告所称“把半写当成功”不准确。当前生产 factory 使用的 direct 路径也是 `ArduPilotRawTransport`，不是报告引用的未接入 `DirectSerialTransport`，所以“生产写请求透明重发”的论证不成立。

真实问题是：写请求超时、CRC/echo 错误或其他不确定失败后，没有先执行 `DeviceReset`/`InterfaceExit` 或重新识别目标，循环会记录该目标失败后继续下一目标。在硬件写操作中，超时不能判断 EEPROM 完全未改变；继续使用同一协议/设备状态处理后续目标不安全。

**修复建议**

1. 将写超时、链路错误、CRC/echo 错误分类为 `write_state_unknown`。
2. `write_state_unknown` 立即停止整个批次，不进入下一目标。
3. best-effort 执行 `DeviceReset` 和 `InterfaceExit`，关闭并重新建立 transport。
4. 重新扫描并读取完整 EEPROM 后才允许再次写入；UI 明确显示“写入状态未知”。
5. 只对明确幂等的读请求自动重试，写请求不得由底层透明重发。

**必要测试**

- 写 ACK 丢失、部分回显、CRC 错误均停止批次。
- 故障后不会对第二目标发送 `DeviceInitFlash`/write。
- 恢复失败时会话终止并释放协议暂停和租约 pin。

### M1. FTP 递归删除信任飞控返回的子项名称，可逃逸确认子树

**位置**

- `src/server/mavlink/MavlinkFtp.ts:186-188`
- `src/server/mavlink/MavlinkFtp.ts:497-524`
- `src/server/mavlink/MavlinkFtp.ts:869-895`

**核实后的描述**

客户端提交的初始路径经过 `devicePath()`，但递归展开使用飞控 `ListDirectory` 返回的名称。目录记录只过滤字面量 `.`/`..`，文件记录连这一步也没有；包含 `/`、`\\` 或 traversal segment 的名称会被直接拼入后续 RemoveFile/RemoveDirectory 请求。

影响限于飞控侧文件系统，且需要恶意飞控、受控固件或串口 MITM，因此定为 Medium。

**修复建议**

1. 所有返回名称必须是单一 basename：非空、不为 `.`/`..`、不含 `/` 或 `\\`、不含控制字符。
2. 用 POSIX 语义规范化拼接结果，并验证仍是原确认根目录的严格后代。
3. 删除展开记录 canonical root；每次发送删除前再次检查包含关系。
4. 遇到非法目录项立即中止整个删除事务，而不是静默跳过后继续。

### M2. DataFlash 日志请求长度未经 uint16 钳制

**位置**

- `src/server/mavlink/MavlinkLogTransfer.ts:555-605`
- `src/server/mavlink/MavlinkBridge.ts:1627-1647`

**核实后的描述**

`LOG_REQUEST_DATA.count` 是 uint16，当前代码可能把完整缺口 `reqEnd - reqStart` 直接赋值。序列化时会静默截断。大于 65535 字节的日志可能退化为异常小请求；恰为 64 KiB 倍数时可能编码为 0，其语义依赖飞控实现并可能导致下载停滞。

**修复建议**

在生成请求时使用：

```ts
const count = Math.min(reqEnd - reqStart, 0xffff)
```

外层 missing interval tracker 已能继续请求剩余缺口。增加 65535、65536、131072 和 512 MiB 广告大小的边界测试，并断言所有 wire count 均为 `1..65535`。

### M3. FTP/DataFlash 流式接收在确认进展前重置静默计时器，取消可能被持续流量拖住

**位置**

- `src/server/mavlink/MavlinkFtp.ts:714-755`
- `src/server/mavlink/MavlinkLogTransfer.ts:555-605`
- `src/server/mavlink/MavlinkFtp.ts:269-277`
- `src/server/mavlink/MavlinkLogTransfer.ts:173-181`

**核实后的描述**

匹配 session/log id 的回复在确认有效进展前就重置 quiet timer。恶意或异常设备持续发送零长度、重复范围或其他无进展块时，单次 pass 可以长期不结束。sink 内没有统一的立即 cancel 检查，因此持续流量还可能使取消迟迟不能回到外层循环。

DataFlash 日志列表的 `onEntry` 已检查 cancel；原报告“所有列表取消均失效”过于宽泛。

**修复建议**

1. 只有 missing bytes 实际减少、EOF 或合法 burstComplete 才刷新 progress deadline。
2. 增加独立、不可被数据重置的绝对 pass deadline。
3. sink 第一行检查 `cancelRequested`，立即 detach sink 并结束。
4. 对重复块、越界块、零长度非 EOF 块计数，达到上限后报 protocol/stalled。

### M4. ESC 事务接收缓冲无累计上限且反复拼接

**位置**

- `src/server/esc/ArduPilotRawTransport.ts:70-71`
- `src/server/esc/ArduPilotRawTransport.ts:115-119`
- `src/server/esc/ArduPilotRawTransport.ts:180-205`
- `src/server/esc/Px4SerialControlTransport.ts:90-95`

**核实后的描述**

事务期间 `rxChunks` 没有最大累计字节数，每次新数据都重新 concat 全部 chunk。高输入速率设备可在超时窗口内造成显著内存和 O(n²) CPU 消耗。事务超时提供时间上界，但不提供字节/工作量上界。

**修复建议**

1. 按协议最大响应帧加少量噪声余量设置 `maxBufferedBytes`。
2. 使用有界 ring/contiguous buffer 和增量 framing，避免每 chunk 全量 concat。
3. 超限立即报 `rx_overflow`、终止事务并重同步/关闭会话。

### M5. ESC start 的链路 busy gate 未覆盖 Shell、FTP 和日志传输

**位置**

- `src/server/index.ts:1239-1247`
- `src/server/index.ts:1678-1707`
- `src/server/mavlink/MavlinkBridge.ts:1792-1924`

**核实后的描述**

传给 `EscService` 的 `isLinkBusy` 只检查参数同步、传感器校准和 Radio 校准，没有覆盖 shell active/pending、FTP busy、DataFlash log transfer busy。ESC 路由发生在通用 bridge mutation gate 之前，因此这些操作进行中仍可能启动 ESC 会话并暂停或独占底层链路。

**修复建议**

由 bridge 暴露一个权威、只读的 `getLinkMutationBlocker()`，统一返回 parameter sync、calibration、radio、shell、FTP、log 和其他独占事务。ESC start 在 claim/pin 前检查一次，transport open 提交前再检查一次。

### M6. `parameterTypes` 可绕过参数值缓存上限持续增长

**位置**

- `src/server/mavlink/MavlinkBridge.ts:358-368`
- `src/server/mavlink/MavlinkBridge.ts:2036-2058`

**核实后的描述**

`parameterValues` 达到 8192 个新 ID 后，`cacheParameterValue()` 返回 false；调用者忽略返回值，仍无条件执行 `parameterTypes.set(id, paramType)`。异常或恶意飞控可持续发送不同的合法参数 ID 增长该 Map。

**修复建议**

```ts
if (!this.cacheParameterValue(id, value)) return
this.parameterTypes.set(id, paramType)
```

如仍需向前端报告被丢弃参数，应在不持久化 ID 的情况下发送有界聚合告警。测试发送超过 8192 个唯一 ID，并断言两个 Map 都不超过同一上限。

## 3. 已确认的 Low / 加固项

### L1. 端口枚举和 dev debug endpoint 暴露设备指纹

`/api/connections/scan` 在本地模式无 token；dev 的 `/api/connections/debug-ports` 返回原始 `pnpId`。Bluetooth 扫描还返回 MAC、配对名称、VID/PID。默认 loopback 限制了攻击面，remote 模式的 `/api` 有全局 token，因此定为 Low。

建议默认响应只返回 opaque port id、显示所需的脱敏名称和 `recommended`；原始路径、MAC、`pnpId` 仅在明确 debug 开关且持有控制权限时提供。

### L2. FTP/DataFlash 内部错误可能泄露主机绝对路径

非领域错误的原始 `error.message` 会进入 WS 操作错误，磁盘错误可能包含 `%TEMP%\\openconfigurator-*`。建议对客户端只返回稳定错误码和通用消息，把原始错误写入服务端日志；remote 和 local 模式保持同一脱敏边界。

### L3. Radio calibration 写入缺少 manager 级总超时和孤儿写保护

Radio manager 进入 `writing` 后依赖 bridge completion，没有总 deadline。owner 断开会启动 orphan timer；timer 到期可结束 manager 会话并释放租约，底层写 completion 随后被忽略。

建议写阶段不因普通 orphan timeout 释放 pin；增加有界总超时、可取消/可观察的 bridge transaction handle，并在结束前确认 pending PARAM_SET 已完成或已明确进入恢复流程。

### L4. dev 模式信任任意 loopback `:5173` Origin

`allowDevOrigin` 时任意运行在本机 5173 端口的页面都属于允许 Origin。它是开发期便利设计，不是生产远程漏洞。建议仅在显式 dev server 启动令牌存在时启用，或为 Vite dev proxy 使用每次启动随机 bootstrap secret。

### L5. MAVLink signing 策略需要收紧和文档化

`SIGNATURE_MAX_AGE_TICKS = 6_000_000` 按 MAVLink 10 微秒 tick 计算约为 60 秒，不是原报告所称 16.7 小时。当前 first packet 只有过去时间下界，没有未来时间上界；一个通过签名验证的未来时间戳可能污染该 source 的 replay watermark。

配置 signing key 时 `requireSigned` 默认 false 是兼容性策略事实，不等同于无条件签名绕过。建议：

- 增加未来时间戳容差上界；
- 安全模式下配置 key 默认要求签名，兼容模式必须显式开启并打印告警；
- 文档说明 signing 只保护签名帧、stale-first 和 source cache 的权衡；
- 不把 256-source LRU 驱逐列为已确认漏洞：填充 Map 的数据必须先通过签名验证。

### L6. 临时文件、4-Way 重同步和小型边界加固

- FTP/DataFlash 在下一次下载时会清理上次进程遗留文件；若服务崩溃后长期不再下载，`.part` 可继续占用磁盘。建议服务启动时执行有目录边界检查的清理，并按年龄/总量限制。
- 4-Way parser 可能把噪声中的 `0x2e` 当帧头，使当前事务等待到 timeout。事务结束会清空 RX，因此不是“永久死锁”。建议在结构/CRC 失败后滑动查找下一个候选帧头，并设置扫描工作量上限。
- `escChannels()` 应拒绝重复 PX4 channel，避免重复扫描/写同一物理目标。
- 定时器和 EventEmitter 回调应有统一异常边界；后台维护 timer 在不影响生命周期语义时调用 `.unref()`。

## 4. 功能/部署问题，不作为安全漏洞

### 4.1 远程浏览器认证流程不完整

远程模式 HTTP API 要求 Authorization 或 `X-SkyLab-Token`，WS 额外允许 `?token=`。浏览器首个页面导航和普通 `<a>` 下载无法附加自定义 Header，当前前端也没有完整的远程 token bootstrap 流程。

这是部署可用性和认证架构问题。不要简单让所有 HTTP GET 接受长期 query token，因为 URL 可能进入历史、代理日志和引用信息。建议用一次性 bootstrap token 换取 Secure、HttpOnly、SameSite cookie，或由 HTTPS 反向代理统一鉴权；文件下载使用带 Header 的 fetch 后生成短期 Blob URL。

## 5. 待协议证据或 HIL 验证

以下项目有代码迹象，但现有证据不足以按确认漏洞整改：

1. **PX4 多 channel 首事务稳定时间**：切换 channel 后没有单独执行 open 阶段的 2 秒等待，但每次 transact 都携带 device、Exclusive 和 baudrate。需要 PX4 协议资料和多通道 HIL 确认是否必须重新初始化/settle。
2. **无线数传进入 ArduPilot passthrough**：系统不能可靠区分 USB CDC 与 SiK 等串口链路。应做硬件测试并基于设备身份/显式操作模式限制，不能仅按 57600 波特率猜测。
3. **AM32 跨字段约束**：需要针对实际 layout 字段和官方/实机证据确认哪些相对关系是固件强约束，之后再加入 encoder/server validation。
4. **Windows UNC/命名设备行为**：任意端口路径边界已经成立，但 NetNTLM 外泄、named pipe 或特定 `\\.\\` 路径是否被 serialport binding 打开，需要 Windows 隔离环境复现，不应把推测后果写成已证实。
5. **MAVLink first-packet 未来时间戳与设备时钟兼容**：修复前需要选定允许的 clock skew，并测试无 RTC 飞控和显式 stale-first 模式。

## 6. 已删除的误报

下列结论与当前代码不符，不进入漏洞清单：

| 原结论 | 删除理由 |
| --- | --- |
| ESC finalize 时 signal 已 abort，导致必然跳过 `InterfaceExit` | `finalizeSession()` 先调用 `beforeTransportClose`，之后才 `session.abort.abort()`；`link_lost` 路径主动跳过 exit 是链路已丢失后的处理。 |
| 单个 `.` 噪声使整个 4-Way 会话永久死锁 | 最多拖住当前事务至 timeout；事务 finally 会清空 RX。保留为 Low 重同步加固。 |
| ConnectionManager disconnect 在 cleanup await 中递增 generation，必然泄漏监听器 | 正常流程等待 cleanup 完成后才递增 generation，并合并重复 cleanup；所述竞态链未闭合。 |
| Bluetooth label fallback 忽略请求中已有 MAC/VID/PID | 有 MAC 或 VID/PID 时控制流提前返回，不会进入 label fallback。 |
| 标定 cancel 后晚到 Done 覆盖 cancelled | `handleStatustext()` 和其他 handler 先检查 terminal；取消完成后晚到消息被忽略。 |
| MAVLink 签名重放窗口为 16.7 小时 | 时间单位换算错误；当前常量约为 60 秒。 |
| direct ESC 生产写路径使用 `DirectSerialTransport` 自动重发写请求 | 当前 `EscService` direct factory 使用 `ArduPilotRawTransport`；`DirectSerialTransport` 未接入生产路径。 |
| ESC 写超时被当作成功 | 超时目标记录为失败；真实缺陷是未恢复未知设备状态便继续批次。 |
| FTP 路径完全安全，因为客户端 `devicePath()` 禁止 `..` | 递归 child name 来自设备响应，不经过该校验；已作为 M1 保留。 |
| 所有日志列表取消均失效 | DataFlash list sink 已直接检查 cancel；问题集中在下载 pass 的进展/静默计时。 |
| 任意客户端可立即抢占尚未过期的他人租约 | 当前会返回 `controller_conflict`；漏洞发生在空闲/过期租约和失败请求副作用。 |
| HSTS 必须由当前 Node HTTP 服务直接设置 | 远程部署要求 HTTPS/WSS，HSTS 通常由 TLS 终止代理负责；应写入部署基线而非当前代码漏洞。 |

## 7. 推荐实施顺序

### 阶段 A：授权与飞行安全边界

1. 修复 H2：封闭通用 `param_set`。
2. 修复 H1：统一 REST/WS 控制凭据，端口绑定扫描结果，失败 claim 回滚。
3. 修复 H3：所有 ESC MAVLink 模式统一 armed/target/epoch commit-time gate。
4. 为以上三项添加 server boundary 回归测试，再运行 `npm run typecheck`、`npm run test:server`、`npm run test:protocol`。

### 阶段 B：ESC 写入恢复

1. 引入 `write_state_unknown` 和停止批次语义。
2. 实现 reset/exit/close/reopen/re-identify 恢复流程。
3. 增加模拟 ACK 丢失、CRC、断链和 owner disconnect 的故障注入测试。
4. 台架验证前不得宣称硬件恢复完整；HIL 必须记录 MCU、layout、transport、固件版本和电源条件。

### 阶段 C：协议输入与资源上限

1. 修复 FTP child containment。
2. 钳制 LogRequestData count。
3. 为 FTP/log pass 增加绝对 deadline、立即 cancel 和无进展上限。
4. 为 ESC RX 和 parameterTypes 增加空间上限。

### 阶段 D：纵深防御与部署

1. 信息脱敏、debug endpoint 隔离、临时文件启动清理。
2. 完成远程浏览器认证 bootstrap 设计。
3. 文档化 MAVLink signing 安全模式和反向代理 TLS/HSTS 基线。
4. 执行剩余 HIL/平台验证，再决定是否提升待验证项的等级。

## 8. 完成标准

- 每个确认漏洞都有至少一个“修复前失败、修复后通过”的聚焦测试。
- 所有 mutation 在发送前重新读取实时 connection、target、capability、controller 和 safety authority。
- 所有设备输入循环同时具备时间、字节数和无进展次数上限。
- ESC EEPROM 写入只在完整读回一致后成功；不确定失败停止批次并进入恢复状态。
- `npm run typecheck`、`npm run test:server`、`npm run test:protocol` 全部通过。
- 硬件相关结论明确区分单元测试、SITL 和 HIL，不以硬件无关测试替代实机证据。
