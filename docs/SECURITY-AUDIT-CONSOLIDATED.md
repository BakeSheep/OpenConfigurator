# OpenConfigurator 综合安全审查报告

> 审查日期：2026-08-21  
> 审查对象：当前工作树中的 OpenConfigurator 前端、Node.js 后端、MAVLink/ESC/日志处理路径与 Electron 外壳  
> 来源：两份独立审查报告及对当前代码的静态复核  
> 限制：未进行真实飞控 HIL、在飞测试、长时间内存压测或全部依赖 CVE 可达性分析

## 1. 执行摘要

两份原始报告的覆盖面基本互补：

- 第一份主要覆盖 MAVLink 目标选择、签名降级、缓存上限、Shell 会话、临时目录与协议状态机。
- 第二份主要覆盖原始参数写入、ESC 会话、恶意日志资源消耗、前端/Electron 硬化、构建供应链与依赖漏洞。

本报告不直接沿用原始编号和定级，而是根据当前代码重新去重、合并和分级。最重要的结论是：

1. **原始 `param_set` 缺少服务端 armed 和敏感参数安全门，是当前最明确的高优先级问题。**
2. **ESC 的 PX4/direct 路径与会话生命周期没有完整的 armed 边界，需在入口和每次操作前重新校验。**
3. 签名降级、参数类型/缓存、Shell owner、tmp 目录和恶意 FTP 传输均是真实的中危或中优先级缺陷。
4. 首心跳自动选目标的行为真实，但单独定为 High 不准确；未签名 MAVLink 总线上的主动攻击者本来就能伪造真实目标 ID。
5. `uncertainCommands` 无 TTL 是故意的 fail-closed 设计；DataFlash 短块截断是 `LOG_DATA` 的协议终止语义，两者不应按安全漏洞修复。
6. 第二份报告中多个日志解码器路径与当前工作树不匹配，相关结论在重新定位和 PoC 前不计入已确认漏洞。

## 2. 分级与状态定义

### 2.1 严重度

| 级别 | 定义 |
| --- | --- |
| High | 可绕过飞行/电机安全门，或在已解锁状态影响飞控、执行器或关键安全参数 |
| Medium | 可造成未授权会话接管、数据权威混淆、持久拒绝服务或服务进程资源耗尽 |
| Low | 需要强前提、影响有限，或主要是恢复性、防御深度与远端文件范围问题 |
| Informational | 硬化、隐私、可观测性、发布治理或明确的设计权衡 |

### 2.2 复核状态

| 状态 | 含义 |
| --- | --- |
| Confirmed | 当前代码路径可直接证明问题核心成立 |
| Partial | 代码行为存在，但攻击条件、影响或原始定级被夸大 |
| Needs PoC/HIL | 静态代码显示风险，但需对当前版本构造 PoC、内存压测或真实飞控验证 |
| Not accepted | 属于协议正常语义、明确安全权衡、不可利用的未来风险或当前代码不存在 |

## 3. 综合发现总览

| ID | 严重度 | 状态 | 标题 |
| --- | --- | --- | --- |
| OCSA-001 | High | Confirmed | 原始 `param_set` 绕过 armed、安全参数确认和权威类型门 |
| OCSA-002 | High | Confirmed / HIL pending | ESC PX4/direct 和会话运行期缺少完整 armed 边界 |
| OCSA-003 | Medium | Confirmed | 配置签名密钥后仍默认接受无签名包 |
| OCSA-004 | Medium | Partial | 首个飞控心跳自动选为操作目标 |
| OCSA-005 | Medium | Confirmed / firmware-dependent | `param_set` 信任客户端声明的 `paramType` |
| OCSA-006 | Medium | Confirmed | `parameterTypes` 无上限且未准入 ID 仍广播 |
| OCSA-007 | Medium | Partial | PX4 Shell 没有会话 owner，输出对所有 WS 客户端广播 |
| OCSA-008 | Medium | Confirmed / environment-dependent | 可预测 tmp 下载目录跟随符号链接并跨实例清理顶层文件 |
| OCSA-009 | Medium | Confirmed | 对抗性 FTP/DataFlash 回复可令 pass/列表长时间不终止 |
| OCSA-010 | Medium | Needs PoC on current tree | 恶意日志的 schema/事件/参数/轨迹内存放大 |
| OCSA-011 | Low | Partial | ArduPilot Autotune abort 丢失后 action 长时间 pending |
| OCSA-012 | Medium | Confirmed | 参数枚举生成脚本使用可变远端源且无哈希验证 |
| OCSA-013 | Low | Confirmed | 未来签名时间戳可毒化防重放水位 |
| OCSA-014 | Low | Confirmed | `downloadDirReady` 永久缓存首次失败 Promise |
| OCSA-015 | Low | Confirmed | 飞控身份变更不会终止活动校准会话 |
| OCSA-016 | Low | Confirmed | FTP 递归删除信任飞控返回的文件名 |
| OCSA-017 | Informational | Not accepted as vulnerability | `uncertainCommands` 无 TTL 是 fail-closed 设计 |
| OCSA-018 | Informational | Not accepted as vulnerability | DataFlash 短块收缩是 `LOG_DATA` 终止语义 |
| OCSA-019 | Informational | Confirmed | 运行时从 Google Fonts 加载资源 |
| OCSA-020 | Informational | Not accepted as current XSS | React i18next `escapeValue:false` 本身不构成当前 XSS |

## 4. 详细发现

### OCSA-001 — 原始 `param_set` 绕过参数级安全门

**严重度：High**  
**状态：Confirmed**

**位置**

- `src/server/mavlink/MavlinkBridge.ts:2340-2345`
- `src/server/mavlink/MavlinkBridge.ts:2940-2988`
- `src/server/mavlink/MavlinkBridge.ts:3168-3240`
- `src/server/index.ts:330-369`
- `src/web/pages/ParameterPage.tsx:80-91`

**问题**

`vehicle_config_set` 会执行车辆/功能白名单、实时未解锁、参数存在性、范围/枚举以及降低 failsafe 二次确认。通用 `param_set` 只要求 ready target、可写车辆 profile 和 controller lease，然后直接使用客户端提供的 ID、值和类型序列化 `PARAM_SET`。

服务端没有检查 `lastArmedState === false`，`param_set` 也不属于 `safetyExpectation()` 覆盖范围。参数页的 `canWrite` 同样未包含 armed 状态，因此这不仅是手工构造 WS 消息的绕过。

**影响**

- 已解锁时写入 PID、输出映射、failsafe 和解锁检查等参数。
- 前端的 `CBRK_` 确认仅存在于浏览器，后端不验证该承诺。
- 参数导入可以连续通过同一通道写入。

**建议**

1. 在服务端建立统一 `ParamWritePolicy`，每次发送前重读 target、identity、capability、armed、controller 和 safety epoch。
2. 对客户端发起的通用参数写入默认要求 `armed === false`。
3. 对 circuit breaker、arming、failsafe、output function 等敏感参数要求服务端承诺和 safety epoch。
4. 区分用户原始写入、已验证设置流程、回滚和内部协议写入，避免简单在 `sendParamSet()` 中一刀切破坏安全回滚。

### OCSA-002 — ESC armed 安全边界不完整

**严重度：High**  
**状态：代码缺口 Confirmed，物理影响需 HIL**

**位置**

- `src/server/esc/ArduPilotRawTransport.ts:84-113`
- `src/server/esc/EscService.ts:99-132`
- `src/server/esc/EscService.ts:190-250`
- `src/server/esc/Px4SerialControlTransport.ts:119-160`

**问题**

| 路径 | 当前门禁 | 缺口 |
| --- | --- | --- |
| ArduPilot raw passthrough | 入口检查 armed 已知、未解锁和 vehicleReady | 会话运行期未重新校验；MAVLink 暂停后很难观测后续状态 |
| PX4 `SERIAL_CONTROL` | 检查 PX4 family、ready target 和 `PASSTHRU_EN` | 入口无 armed 门，收到后续 armed 心跳也不终止 ESC 会话 |
| direct 19200 serial | 检查已打开 serial 且波特率为 19200 | 如该连接已经表现为活体飞控，仍可暂停 MAVLink 并借用链路 |

direct 模式设计上表示“串口直接连接 ESC”，不能把所有 direct 使用都描述为窃取飞控串口。但如当前连接已观测到 `vehicleReady === true` 或非 null armed 状态，仍应 fail closed。

**建议**

1. 建立一个 ESC server-authoritative safety context，并在 start、scan、read、write 前都重新校验。
2. PX4 路径收到 armed heartbeat 时立即中止会话、释放 exclusive UART 并通知 owner。
3. direct 路径如观测过飞控心跳/活动，拒绝转换为 direct；需通过明确断开并以 direct-ESC 预设重连后才可进入。
4. 会话期间任何 target、identity、authority、armed 或连接代次变化都应终止操作。

### OCSA-003 — MAVLink 签名可降级为无签名入站

**严重度：Medium**  
**状态：Confirmed**

**位置**

- `src/server/mavlink/codec.ts:41-47`
- `src/server/mavlink/codec.ts:128-148`
- `src/server/mavlink/codec.ts:473-518`

设置 `MAVLINK_SIGNING_KEY` 但未设置 `MAVLINK_SIGNING_REQUIRE=1` 时，无签名包直接通过，也不进入防重放时间戳检查。主动链路攻击者可以剔除签名流量并注入同源无签名帧。

**建议**

- key 存在但 REQUIRE 未开启时输出明显警告。
- 提供按 `(sysid, compid)` 的 graceful 模式：一旦观测到有效签名，该源之后强制签名。
- 不可信或多点链路默认使用 `MAVLINK_SIGNING_REQUIRE=1`。

### OCSA-004 — MAVLink 目标稳定性与多目标冲突

**严重度：Medium**  
**状态：Mitigated（主动总线攻击风险仍需 MAVLink signing）**

**位置**

- `src/server/mavlink/MavlinkBridge.ts:1043-1064`
- `src/server/mavlink/MavlinkBridge.ts:826-851`

单一飞控需要连续 3 个心跳达到稳定门槛后才自动绑定。出现多个稳定的不同 SYS/COMP 目标时，写操作失败关闭并要求用户显式选择；同一 SYS ID 出现多个稳定身份时，显式选择也不会解除冲突，必须断开重复设备或修改 ID。心跳稳定性只能减少误选，不能认证未签名总线上的主动攻击者。

**建议**

- UI 在单一稳定目标时不增加第二次选择；仅多目标冲突时显示候选项。
- 多目标或身份冲突时不进入可写状态。
- 安全性依赖强制签名、预配置 target allowlist 或可验证身份，而不是心跳计数。

### OCSA-005 — `paramType` 信任客户端声明

**严重度：Medium**  
**状态：服务端缺口 Confirmed，实际飞控影响需 HIL**

**位置**

- `src/server/validation.ts:391-414`
- `src/server/mavlink/MavlinkBridge.ts:3168-3240`

服务端已从 `PARAM_VALUE` 缓存 authoritative type，但原始写入使用客户端声明的 `paramType`进行范围检查和编码，不与 `parameterTypes.get(id)` 比对。声明 REAL32 可以跳过本地整数范围检查；飞控是拒绝、按实际类型解码还是接受则依赖固件。

**建议**

- 客户端不再决定参数类型；服务端只使用已选目标的 authoritative cache type。
- 未缓存参数默认拒绝写入，或使用与普通参数页分离的明确 expert flow。

### OCSA-006 — 参数类型缓存和 WS 广播无共享准入上限

**严重度：Medium**  
**状态：Confirmed**

**位置**

- `src/server/mavlink/MavlinkBridge.ts:366-375`
- `src/server/mavlink/MavlinkBridge.ts:2090-2104`

`parameterValues` 达到 8192 个新 ID 后拒绝缓存，但返回值被忽略；`parameterTypes.set()` 和 `param` WS 事件仍无条件执行。被选中的恶意目标可通过持续变更合法短 ID 耗尽内存并放大广播。

**建议**

- value/type 使用同一准入决定。
- 未准入的非 pending ID 直接停止广播。
- 对参数流量添加每目标速率/唯一 ID 增长检测。

### OCSA-007 — PX4 Shell owner 边界不完整

**严重度：Medium**  
**状态：Partial**

**位置**

- `src/server/mavlink/MavlinkBridge.ts:1793-1814`
- `src/server/mavlink/MavlinkBridge.ts:1909-1937`
- `src/server/index.ts:278-306`
- `src/server/index.ts:624-628`
- `src/server/index.ts:1915-1921`

Shell 只有全局 active/pending 状态，没有 owner ID 或 recovery token；输出作为普通 server message 广播给全部 WS 客户端。

原始报告称“任意客户端随时写入”并不准确：`shell_open/write/close` 均要通过 controller lease。真实缺口是 Shell 未 pin lease，在默认 30 秒租约到期或 owner 断开后，其他客户端可取得控制权并接管未关闭的 Shell。

**建议**

- 使用与 calibration/ESC 一致的 owner + recovery token + pinned lease。
- shell output/status 只发送给 owner，可选向观察者发送不含输出内容的 busy 状态。
- owner 断开后进入有界 orphaned 状态，超时自动关闭。

### OCSA-008 — 临时下载目录可预测且首次使用时枚举清理顶层文件

**严重度：Medium**  
**状态：Confirmed，实际可利用性依赖 OS 符号链接保护和部署账号**

**位置**

- `src/server/mavlink/MavlinkFtp.ts:208-210`
- `src/server/mavlink/MavlinkFtp.ts:530-542`
- `src/server/mavlink/MavlinkLogTransfer.ts:140-150`
- `src/server/mavlink/MavlinkLogTransfer.ts:407-419`

FTP 和 DataFlash 使用两个分离但固定可预测的 tmp 目录。`mkdir({recursive:true})` 之后没有 `lstat`/nofollow 边界，随后对目录顶层名称执行 `unlink`。在系统未阻止跨用户 tmp symlink 跟随时，可删除服务账号有权删除的目标目录顶层文件。多进程/多 bridge 使用同一默认目录时也会互相清理已注册下载。

**建议**

- 使用原子 `mkdtemp()` 创建进程/服务实例私有 0700 目录。
- 清理仅匹配自身随机文件格式，并将崩溃遗留目录的按年龄清理与运行期下载目录分离。
- 不使用单独 `process.pid` 作为安全的唯一性来源。

### OCSA-009 — 对抗性 FTP/DataFlash 传输可持续占用状态机

**严重度：Medium**  
**状态：Confirmed，内存峰值需压测**

**位置**

- `src/server/mavlink/MavlinkFtp.ts:470-524`
- `src/server/mavlink/MavlinkFtp.ts:715-757`
- `src/server/mavlink/MavlinkFtp.ts:760-813`
- `src/server/mavlink/MavlinkLogTransfer.ts:547-604`

FTP burst pass 每收到一个同 session 回复就重置 quiet timer，即使回复重复、无进展且没有 `burstComplete`。恶意固件可持续发送包使当前 pass 永不返回，外层 no-progress 上限也就无法生效。

FTP 列目录的上限只计入解析后的 file/dir 条目，`S` 或未知记录只增加 wire offset。连续返回这类页可绕过 `LIST_MAX_ENTRIES` 并让列表操作持续进行。DataFlash pass 存在类似的“有包便重置 quiet timer”特征。

**建议**

- 每个 pass 同时设置不受流量影响的 hard deadline、最大帧数和最大无进展帧数。
- 目录上限同时统计 wire records、页数和 offset 增长。
- interval 数组设最大区间数；超限时改用顺序重试或拒绝异常传输。

### OCSA-010 — 恶意日志导致解码/导出/地图内存放大

**严重度：Medium（暂定）**  
**状态：Needs PoC on current tree**

原始报告合并了四类风险：

- DataFlash UNIT/MULT/FMT 重定义可能造成 schema 重建放大。
- 结构化导出在流式输出记录的同时，仍累积 schema、event、parameter 和 issue 集合。
- ULog 索引与参数集合可随恶意消息数量增长。
- GPS 轨迹仅按时间间隔降采样，没有总点数硬上限，最终向地图传递整个 polyline。

当前代码中存在无硬上限的集合，但原始报告引用的 `structuredDataflashDecoder.ts` 和 `structuredUlogDecoder.ts` 不存在于当前工作树，因此不能直接接受其行号和放大倍数。

**验证要求**

1. 对当前 decoder 构造可重复 schema、极端参数数量和长时 GPS 轨迹的最小文件。
2. 记录 worker heap、主线程 heap、解码时间、地图渲染时间和取消延迟。
3. 确定正常 512 MiB 允许下载上限下的可接受内存预算，再为 schema、event、parameter、track 和 index 分别设限。

### OCSA-011 — Autotune abort 丢失后长时间 pending

**严重度：Low**  
**状态：Partial**

**位置**

- `src/server/mavlink/AutotuneSession.ts:249-284`
- `src/server/mavlink/AutotuneSession.ts:376-390`

ArduPilot abort/restore/test 通过一次 `SET_MODE` 发送并等待心跳模式或 STATUSTEXT 收敛。如该帧丢失，`actionPending` 没有独立 action timeout，后续 action 被拒绝。

原报告的“永久卡死”不准确：会话仍有 30 分钟 overall timeout，操作员也可以通过飞控/遥控模式变化终止 autotune。但 GCS 的中止按钮在长时窗口内确实失去可用性。

**建议**

- 为 action 添加有界 timeout 和重试/再发送策略，但需避免将迟到状态误归属为新 action。
- 始终保留独立、服务端允许的安全模式退出路径。

### OCSA-012 — 参数枚举构建源未锁定

**严重度：Medium**  
**状态：Confirmed**

**位置**

- `scripts/generate-parameter-enums.mjs:4-17`

PX4 参数枚举从 QGroundControl `master` 分支下载，ArduPilot 枚举从可变的在线路径下载，未锁定 commit、版本或内容哈希。如该脚本用于发布构建，远端内容变更会直接编译到发行版的参数语义和枚举选项中。

**建议**

- 锁定 commit/tag 并记录 SHA-256；发布构建默认使用仓库内已审查快照。
- 远端刷新作为显式维护操作，并对输出 diff 执行 review。

### OCSA-013 — 未来签名时间戳毒化防重放水位

**严重度：Low**  
**状态：Confirmed**

**位置**

- `src/server/mavlink/codec.ts:488-517`

首个签名包只检查过旧，没有检查过度超前。持有密钥的源发送极大时间戳后，同 `(sysid, compid, linkId)` 正常包都会被当作 replay。这是密钥持有者自伤/配置异常的可用性问题，不是越权。

**建议**

- 首次接触使用对称时间窗，并为 no-RTC 模式保留显式兼容选项。

### OCSA-014 — 下载目录准备失败无法重试

**严重度：Low**  
**状态：Confirmed**

`MavlinkFtp` 和 `MavlinkLogTransfer` 都会缓存 `ensureDownloadDir()` 创建的 Promise。首次 `mkdir` 失败时，rejected Promise 留在字段中，同一服务实例之后所有下载立即重用该失败。

**位置**

- `src/server/mavlink/MavlinkFtp.ts:530-542`
- `src/server/mavlink/MavlinkLogTransfer.ts:407-419`

**建议**

- Promise reject 时在同步保护下将 `downloadDirReady` 恢复为 null，并保留本次具体错误。

### OCSA-015 — 身份变更不终止校准会话

**严重度：Low**  
**状态：Confirmed**

**位置**

- `src/server/mavlink/MavlinkBridge.ts:1066-1094`
- `src/server/mavlink/MavlinkBridge.ts:2240-2243`

HEARTBEAT `autopilot/type` 改变时会终止 autotune 和 airframe transaction，但 active calibration 仅在解锁、target reset/switch 或 bridge destroy 时终止。会话仍会消费新身份下的 `[cal]` STATUSTEXT 和 MAG_CAL 消息。

**建议**

- `identityChanged` 分支立即以 `identity_changed` 终止并清除 active calibration。

### OCSA-016 — FTP 递归删除信任远端文件名

**严重度：Low**  
**状态：Confirmed**

**位置**

- `src/server/mavlink/MavlinkFtp.ts:497-523`
- `src/server/mavlink/MavlinkFtp.ts:840-895`

目录记录会过滤精确 `.`/`..`，文件记录不过滤。递归展开使用字符串直接拼接，不再通过 WS `devicePath()` 的 `..` 验证。精确 `F..` 往往只会令 RemoveFile 指向目录并被固件拒绝，但 `../victim` 或带 `/` 的恶意名称可能将删除扩展到用户选择目录之外。

**建议**

- 远端列表名称必须是单一 basename：拒绝空字符串、`.`、`..`、`/`、`\\`、控制字符和超长名称。
- 拼接后再执行一次设备路径范围检查。

### OCSA-017 — `uncertainCommands` 无 TTL

**严重度：Informational**  
**状态：Not accepted as vulnerability**

**位置**

- `src/server/mavlink/MavlinkBridge.ts:2695-2704`
- `src/server/mavlink/MavlinkBridge.ts:2739-2759`

COMMAND_ACK 不含 GCS transaction ID。命令超时后保持 uncertain 可防止旧 ACK 被错误归给同 command ID 的新事务。直接加 TTL 会破坏这一安全属性。

可改善恢复 UX：对可观测命令根据权威遥测状态收敛，或要求操作员明确确认物理状态后手动清除不确定性。

### OCSA-018 — DataFlash 短块终止和文件哈希

**严重度：Informational**  
**状态：Not accepted as vulnerability**

**位置**

- `src/server/mavlink/MavlinkLogTransfer.ts:479-521`
- `src/server/mavlink/MavlinkLogTransfer.ts:575-593`

`LOG_DATA count < 90` 是远端日志终止标记，用来处理最新日志的 `LOG_ENTRY.size` 近似值。每个 MAVLink 帧已有 CRC，interval tracker 会重试未填补缺口。恶意飞控可以伪造日志内容，也同样能伪造固件侧哈希，因此远端 CRC 不能建立恶意源的真实性。

可作为可观测性增强记录 `advertisedSize`、`finalSize` 和 `truncated` 状态，但不应将协议的正常短块处理删除。

### OCSA-019 — Google Fonts 运行时依赖

**严重度：Informational**  
**状态：Confirmed**

**位置**

- `index.html:9-16`

应用启动时向 `fonts.googleapis.com` 和 `fonts.gstatic.com` 发起第三方请求，与 local-first/离线产品定位不一致，并暴露基本网络元数据。但这通常不构成 Medium 运行时漏洞。

**建议**

- 将审查后的字体子集自托管并配置离线 fallback。

### OCSA-020 — i18next 转义设置

**严重度：Informational**  
**状态：Not accepted as current XSS**

**位置**

- `src/web/i18n/config.ts:8-22`

`escapeValue:false` 在 React 集成中是常见设置，因为 React 默认对文本子节做 HTML 转义。当前报告也未给出 `dangerouslySetInnerHTML`、属性/协议注入或其他实际 sink。仅以“未来可能误用”不能定为当前 Medium XSS。

建议保持常规 React 安全测试，并禁止将飞控文本传入 raw HTML sink。

## 5. 待独立复核的候选项

以下项目来自第二份报告的低危/摘要部分。它们不应在无 PoC、当前行号和可达性证据的情况下直接计入漏洞数量。

| 候选项 | 初步分类 | 复核重点 |
| --- | --- | --- |
| calibration/autotune/radio manager 同步异常可崩溃后端 | Needs fault injection | 确认 EventEmitter/WS callback 异常是否逃出顶层请求边界，不以 `uncaughtException` 处理器作为主修复 |
| `/api/connections/connect|disconnect` 无独立速率限制 | Needs threat-model review | 远程模式已需 token，仍应防止获授权客户端快速抖动物理链路 |
| codec 假帧头队头阻塞 | Needs PoC | 检查 `startsWithKnownMessage()` 和最大部分帧保留是否已将阻塞限制在有界字节/时间 |
| WS 错误原文透传绝对路径 | Needs sink inventory | 区分 remote/local 模式，对所有 `error.message` 进入 wire message 的路径做统一脱敏 |
| remote WS token 位于 URL query | Hardening | 评估代理/访问日志暴露，优先子协议、短期 ticket 或安全 cookie |
| `debug-ports` 在 `NODE_ENV` 未设置时开启 | Partial | 当前受 remote API token 中间件保护；生产构建仍应显式关闭 dev 端点 |
| serial path 可以是任意字符串 | Platform-dependent | 验证 SerialPort 库和 OS 对非设备节点/特殊文件的行为，优先绑定 scan 返回的服务端设备标识 |
| `connectionPresets` localStorage 缺少逐字段验证 | Client hardening | 局部同源数据污染；确认是否可绕过服务端 connection validation |
| DataFlash 列名 `__proto__` 造成单条记录原型异常 | Needs PoC | 使用 null-prototype 或 `Object.create(null)`，但需证明当前 sink 存在可影响的属性查询 |
| `DirectSerialTransport` 未被生产工厂使用 | Architecture cleanup | 当前 direct 经 `ArduPilotRawTransport(targetMode:'direct')` 复用已开链路；删除死代码或统一为一个已审查实现 |
| four-way `address_guard` 定义但未落实 | Needs protocol review | 确认所有 EEPROM 读写的 MCU/layout/地址范围在最终传输边界重新检查 |
| PX4 `EXCLUSIVE` 释放可靠性 | Needs HIL | 在取消、链路丢失、target switch 和服务崩溃后验证 UART 不会留在 exclusive 状态 |
| GPS 派生纪元未钳制导致 `toISOString()` 异常 | Likely reliability bug | 构造极端 week/time 并确认 worker 错误能否恢复 |
| Foxglove `arrayLength` 声明值信任 | Needs current-path PoC | 检查所有长度运算、buffer bounds 和解码器错误隔离 |
| `VibrationAnalyzer` 未统一过滤 NaN | Low reliability | 确认 NaN 是否传到 FFT/图表并造成持久异常 |
| Electron `authToken:null` 因 `??` 回退到环境变量 | Confirmed semantic mismatch | 桌面服务仍绑定 loopback 且 remote=false，当前影响主要是违反“忽略部署环境变量”承诺 |
| CSP 缺少 `script-src` | Hardening | 当前 header 只限制 frame/base/object；添加适配 Vite/Electron 的明确 production CSP |
| Electron 无 permission request handler | Hardening | 默认拒绝不需要的 camera/microphone/geolocation/notifications 等权限 |
| Windows 产物未签名 | Release governance | 影响发布信任和 SmartScreen，不是应用运行时漏洞 |

## 6. 依赖漏洞处理原则

原始报告记录了 `concurrently/shell-quote`、`nanoid`、`react-router`、`postcss` 等 npm audit 项。依赖结果会随 lockfile、公告和当前日期变化，本报告不将未重新运行的 audit 结果计入上述已确认数量。

处理要求：

1. 在当前 lockfile 上重新执行 `npm audit` 并保存 JSON 证据。
2. 区分 production、development、build-only 和不可达依赖。
3. React Router RSC 模式 CVE 如在本项目 HashRouter/声明式 SPA 不可达，应记录为不适用，不继续计入产品高危数。
4. 执行 `npm audit fix` 前检查版本变更、构建产物和协议测试，不将“可自动 fix”视为无风险修复。

## 7. 修复路线图

### P0 — 飞行与执行器安全边界

1. 修复 OCSA-001：建立 server-authoritative 参数写入策略，阻止 armed 原始写入并保护敏感参数。
2. 修复 OCSA-002：所有 ESC 模式入口和每次 job 重新校验 safety context，并在运行期 armed 时终止。
3. 同时修复 OCSA-005：参数类型只来自选中目标的服务端缓存。
4. 为上述路径增加 target、identity、controller、authority epoch 变更时的失效测试。

### P1 — 身份、会话与服务端可用性

1. OCSA-003：签名配置防降级。
2. OCSA-004：多目标明确确认和冲突 fail-closed。
3. OCSA-006：参数缓存共享上限并抑制未准入广播。
4. OCSA-007：Shell owner、pinned lease、私有输出和 orphan recovery。
5. OCSA-008/009：私有临时目录、hard deadline、wire-record 上限和无进展计数。

### P2 — 解码器、构建与硬化

1. 对 OCSA-010 建立当前版本的恶意日志 corpus 和 heap/time budget。
2. OCSA-012 锁定参数元数据远端版本和哈希。
3. 完成 OCSA-013–016 的低风险修复。
4. 自托管字体，完善 production CSP/Electron 权限策略。
5. 对依赖漏洞执行可达性分析后升级。

## 8. 验证计划

### 8.1 无硬件自动化

- `param_set` 在 armed=true、armed=null、stale safety epoch、类型不匹配和敏感参数无确认时全部 fail closed。
- 参数写入的每个内部流程携带明确 intent，安全回滚不因通用门禁意外失效。
- ESC start/job 在 armed、target switch、identity change、controller change 时终止。
- 签名 key 与 REQUIRE 组合的配置测试，以及混合签名/无签名入站测试。
- 8192 个参数后新 ID 不增长任何持久 Map，也不向 WS 广播。
- Shell 非 owner 写入/关闭/订阅输出被拒绝，owner 断开后按 recovery policy 处理。
- FTP 连续重复 burst、连续 `S` 列表页、乱序/碎片 offset 和无进展数据均在硬预算内终止。
- tmp symlink、已存在错误类型目录、创建失败后重试和多实例隔离测试。
- 恶意日志 corpus 的解码取消、heap 上限、schema/event/track 上限和 worker 异常恢复测试。

### 8.2 HIL/物理硬件

- PX4 在 disarmed 进入 `SERIAL_CONTROL` ESC 会话，然后通过 RC/第二 GCS 解锁，验证会话立即中止且 UART 释放。
- ArduPilot raw passthrough 在各种取消/断线时正确退出 4-way 并恢复 MAVLink。
- direct ESC 只能在明确 direct-serial 连接代次下启动，不能从已观测飞控的链路就地切换。
- 对 PX4/ArduCopter 分别验证错误 `paramType`、armed 参数写入和敏感参数固件端行为。
- Autotune abort 帧丢失、迟到模式变化与二次退出的恢复测试。

### 8.3 完成门禁

任何修复合并前至少执行：

```bash
npm run typecheck
npm run test:server
npm run test:protocol
npm run build
```

涉及布局、参数确认交互、ESC 状态或日志地图时，另行执行对应 Playwright 测试并覆盖 360/768/1024/1440 px、中英文和明暗主题。

## 9. 结论

两份原始报告应作为互补输入，但不应直接累加其高/中危数量。当前最需要优先修复的是服务端参数写入和 ESC armed 安全边界；其次是签名降级、会话 owner、有界缓存/传输以及私有临时目录。

对未经当前版本 PoC 的日志放大、Electron 硬化和依赖公告，应保留在跟踪列表中，但只有在完成可达性、影响和复现验证后才升级为产品漏洞。
