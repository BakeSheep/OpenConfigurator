# OpenConfigurator 后端兼容性与稳定性审计报告

审计日期：2026-07-25
范围：`src/server/`、`src/shared/`、后端运行依赖与部署入口。前端业务与视觉实现不在范围内；只检查了共享协议变更所需的最小前端兼容接线。

## 结论

本轮发现的可复现后端问题均已修复并加入回归覆盖。当前没有遗留的软件级发布阻断项；剩余不确定性集中在真实 PX4、不同操作系统蓝牙驱动和 MAVLink2 signing 设备互通，这些必须通过硬件在环验证，无法由无硬件单元测试替代。

后端现在具有明确的三层状态边界：

```text
native serial/SPP handle
  -> transportOpen（物理链路可用）
  -> vehicleReady（已选 autopilot 的合法 HEARTBEAT）
  -> controller lease（唯一可变更飞控状态的客户端）
```

## 已修复项与证据

| 领域 | 原风险 | 修复后的约束 | 实现与回归证据 |
|---|---|---|---|
| 串口生命周期 | open 超时后 native handle 迟到成功、关闭期 error、同步/异步 write 失败、无界积压；安全命令被普通积压阻塞 | `idle/opening/open/closing` 状态机；代际取消；迟到 open 立即关闭；有界 `critical/high/normal` 队列，同级 FIFO；critical 可淘汰普通积压；关闭失败可观察且保留句柄供重试 | `src/server/connection/SerialConnection.ts`；`SerialConnection.test.ts` priority/overflow tests |
| 蓝牙发现 | Windows incoming/outgoing COM 混淆；仅凭“唯一端口”误连；跨平台识别不足 | path/address/VID/PID/产品 ID 严格唯一匹配；歧义 fail closed；识别 Windows SPP、Linux `rfcomm`、macOS `cu.*` 并排除 incoming 端口 | `BluetoothConnection.ts`；`BluetoothWorker.test.ts` |
| 蓝牙重连 | 旧重连任务污染新连接；端口解析或临时串口无法取消；收到任意字节即误判 ready | worker generation 隔离；port resolution 有界且可立即取消；provisional connection 可取消并等待；指数退避；必须由已验证 heartbeat 确认 ready；结构化 terminal reason | `BluetoothWorker.ts`；`BluetoothWorker.test.ts` hung-resolution cancellation test |
| 连接管理 | connect/disconnect/error 竞态；connect 期间的 disconnect 排队不可达；慢关闭期间仍显示 connected/允许 write；最终快照残留 port/error；普通流量可无限掩盖 heartbeat 丢失 | 操作串行化但 cancellation 立即传给 provisional link；旧回调隔离；清理开始同步离开 connected 并拒绝 write；成功后强制发布清空后的最终状态；早到字节在新 session reset 后回放；soft grace + hard heartbeat deadline | `ConnectionManager.ts`；`ConnectionManager.test.ts` immediate-cancel/final-snapshot/slow-close tests |
| MAVLink framing | parser 跨重连复用；垃圾/半帧增长；大块合法数据被尾裁；v1 设备兼容不足 | 每物理连接独立 codec/TX seq/stats；CRC 由 node-mavlink 校验；parser error 自动重建；残余输入有界但先完整解析合法 burst；300 帧、>4 KiB 单块回归；v1/v2 auto 或显式模式 | `mavlink/codec.ts`；`MavlinkBridge.test.ts` |
| MAVLink2 signing | 无签名策略、未知 incompat flag；reset 后同一录制包重新有效；新进程接受任意陈旧首包 | 可选 32-byte key、出站签名、入站验签、require-signed、未知 incompat flag 拒绝；每 source/link watermark 有界且跨 reset 保留；新 source 首包执行 MAVLink 一分钟 freshness 窗口 | `codec.ts` signing/flags/reset-replay/stale-first-packet tests |
| 目标选择 | 多飞控/组件消息可污染目标、telemetry、ACK 和 liveness | discovery 与 selected target 分离；首个合法 autopilot 锁定；精确 sysid/compid source filter；仅 selected source 的 codec-valid frame刷新 activity | `MavlinkBridge.ts` target/activity tests |
| 命令事务 | ACK 无 request correlation；同 command ID 迟到 ACK 错配；`IN_PROGRESS` 可无限续命 | requestId、source filter、风险感知重试；同 ID 单事务；timeout 后 uncertain/quarantine；orphan/stale ACK 不关联；serial 8×、Bluetooth 12×绝对 deadline，progress 不延长；紧急停机路径不被 ACK 队列阻塞 | `MavlinkBridge.ts` command transaction/quarantine/deadline tests |
| telemetry stream | `SET_MESSAGE_INTERVAL` 的中间 ACK 被误当成功；后续失败不回退 | 仅最终 `ACCEPTED` 标记 supported；`IN_PROGRESS`/`TEMP_REJECTED` 保留兼容路径；终态失败立即 sticky fallback 到 `REQUEST_DATA_STREAM` | `MavlinkBridge.ts` interval ACK regression |
| 参数协议 | PARAM_SET 不等 echo；旧列表值误判；下载无总预算；c-cast 不可精确值永远 mismatch | 写入等待匹配 echo；旧值 mismatch 继续等待；ID/type/range/float32 精度校验；count/deadline/request budget/retry 有界；owner 断线、连接变化、超时和 shutdown 主动取消并恢复 telemetry profile | `MavlinkBridge.ts` parameter tests；`index.test.ts` generation/cancel tests |
| telemetry 语义 | unknown sentinel 被当有效值；GPS DOP、电池、IMU、flow、distance、EKF 字段语义混淆 | unknown 转 `null`；正确缩放和电池实例/电芯语义；raw/scaled IMU 分离；STATUSTEXT 按 bytes 拼接 UTF-8，且 TTL/数量/长度有界；link stats 使用实际 monotonic elapsed | `MavlinkBridge.ts` telemetry/statustext/link tests；`src/shared/types.ts` |
| HTTP/WS 输入 | TypeScript 类型被当成运行时安全边界；危险命令可绕过专用 UI；远程暴露无强约束 | REST/WS 全量运行时校验；有限数值与范围；arm/disarm/takeoff safety confirmation；禁止 force magic 和 motor/servo/stream 绕过；motor 1–12 与 props removed 双层检查 | `server/validation.ts`；`index.test.ts` |
| 网络边界 | 宽松 bind/origin、慢客户端、二进制/超大消息、连接与速率滥用 | 默认 `127.0.0.1`；非 loopback 必须显式 remote + ≥32-byte token；精确 Origin；WS max payload/client/rate、ping/pong、binary reject、硬背压；API JSON errors 和 5xx 脱敏 | `server/index.ts`；`index.test.ts` remote/origin/WS tests |
| 控制权 | 多标签页同时控制；observer 可用 REST 断开 owner；参数下载改变 stream profile 却不占 lease | first-writer controller lease；参数下载也占 lease；连接变化/断线释放；每个 WS 获得独立 `restControlToken`，活跃 owner 存在时 REST connect/disconnect 必须用 owner token，比较采用 constant time | `index.ts`、`shared/types.ts`、最小前端 header 接线；`index.test.ts` 双客户端 REST 回归 |
| 电机命令结果 | ACTUATOR_TEST ACK 没有 instance，请求者无法知道某次 ACK 属于哪个电机 | 启动为 high、停止为 critical 且不受 ACK 队列阻塞；每个成功 dispatch 的 requestId 返回 `motor_test_status: sent_unconfirmed`，明确“已发送但协议无法关联确认”；原始 ACK 不携带 requestId | `MavlinkBridge.ts`、`shared/types.ts`；motor dispatch/priority/ACK regression |
| 部署/关闭 | 信号关闭泄漏句柄；cleanup 永不 resolve；超时后误取消最终 forced exit | 幂等 shutdown；停止 upgrade、HTTP、WS 与 timers；bridge/connection cleanup 并行且捕获同步 throw；返回 `{ timedOut }`；deadline 超时时信号处理器保留强制退出保护 | `index.ts`；`index.test.ts` listen failure、同步 cleanup throw、永久 pending cleanup tests |
| 生产依赖 | `tsx` 仅开发安装会导致 `npm ci --omit=dev && npm start` 失败；传递 `xml2js` 漏洞 | `tsx` 留在 dependencies；浏览器 bundle-only 包移到 devDependencies；Node engine 明确为 `^20.19 || >=22.12`；`xml2js` override 到 0.6.2 | `package.json`、`package-lock.json`；`npm ls` 与 production audit |

## 兼容性合同

- MAVLink 默认为 `auto`：先用 v1 出站，观察到 v2 或 capability 后升级；可通过 `MAVLINK_PROTOCOL=v1|v2` 固定。
- signing 通过 `MAVLINK_SIGNING_KEY`、`MAVLINK_SIGNING_LINK_ID`、`MAVLINK_SIGNING_REQUIRE` 配置；签名时不能使用 v1。
- 默认仅本机访问。远程部署必须显式设置 `HOST`、`SKYLAB_ALLOW_REMOTE=true`、强 token 和精确 allowed origins，并在反向代理上使用 HTTPS/WSS。
- `connected` 兼容字段跟随真实 `transportOpen`；新客户端应同时检查 `status`、`transportOpen` 与 `vehicleReady`。
- REST connection mutation 在没有 active controller 时保持旧行为；存在 owner 时必须携带其 `X-SkyLab-Control-Token`。
- 共享协议仍只位于 `src/shared/`；server 与 web 之间没有交叉导入。

## 最终验证

在 Windows、Node `v24.13.1`、无真实飞控/串口环境执行：

| 命令/检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test:protocol` | 通过；覆盖 framing、CRC、burst、v1/v2、signing、target、transaction、参数和 telemetry |
| `npm run test:server` | 47/47 通过，自然退出，无跳过 |
| `npm run build` | 通过；Vite 仅报告前端 chunk size 提示，与后端审计无关 |
| `npm audit --omit=dev --audit-level=high` | `found 0 vulnerabilities` |
| `npm ls xml2js --all` | 解析为 `xml2js@0.6.2` |
| `npm ls tsx esbuild --omit=dev` | `tsx@4.23.1` / `esbuild@0.28.1` 均在生产依赖树 |
| `git diff --check` | 通过；仅 Git 的 LF→CRLF 工作树提示，无 whitespace error |
| 随机端口 production smoke | status 200、API JSON 404、非法 Origin 403、WS 收到 hello/connection、shutdown `timedOut:false` |

全量开发依赖树中的 React Router advisory 针对其 unstable RSC API；本项目是 HashRouter SPA、没有 RSC，且相关前端包不进入 `--omit=dev` 的后端生产安装。本报告按用户要求不对前端依赖做升级决策。

## 尚需硬件验证

以下不是已知代码缺陷，但发布到真实飞行环境前必须验证：

1. Windows 不同蓝牙芯片/驱动下 outgoing SPP 枚举、拔插和长时间重连。
2. USB 串口与 Bluetooth 57600 baud 下的大型 PX4 参数表完整下载、取消和重试。
3. MAVLink v1-only、v2 unsigned、v2 signed/require-signed 三类真实飞控互通。
4. arm/disarm/takeoff、motor stop-all、手柄 override 的实机安全流程；测试必须拆桨并遵守现场安全规范。
5. 远程部署的 TLS/WSS、反向代理 Origin/Authorization 转发和访问日志脱敏。

在上述 HIL 完成前，不应把“自动化回归通过”等同于飞行安全认证。
