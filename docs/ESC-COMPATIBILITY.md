# ESC 兼容性矩阵

本文件是 ESC 功能的**唯一支持性声明来源**。只有 `Status = supported` 的组合才允许在生产 UI
中开放对应操作；所有未经真实硬件验证的组合一律标注 `planned`，对应能力（写入/刷写/启动音）
在服务端能力快照中保持关闭。

状态定义：

- `planned`：已实现或计划实现，但**未经真实硬件验证**，生产 UI 不开放。
- `read-verified`：真实硬件完成发现与读取验证，仅开放只读。
- `supported`：完成《完成定义》全部条目（读取、写入回读、退出恢复；刷写组合另需断电重启
  再识别），开放对应操作。
- `broken`：验证失败，禁止使用，需附 issue 链接。

## 矩阵

| 平台 | 飞控板 | 飞控版本 | ESC MCU | ESC 固件版本 | Layout revision | 连接方式 | 读取 | 写入 | 刷写 | Status | 验证日期 | 验证人 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ArduPilot | F405（待定） | 待定 | AM32 F051 | 待定 | 待定 | ArduPilot passthrough | — | — | — | planned | — | — |
| ArduPilot | F745/H743（待定） | 待定 | AM32 G071 | 待定 | 待定 | ArduPilot passthrough | — | — | — | planned | — | — |
| ArduPilot | 待定 | 待定 | AM32 F421 | 待定 | 待定 | ArduPilot passthrough | — | — | — | planned | — | — |
| PX4 | F7/H7（bitbang 固件） | 待定 | AM32 F051 | 待定 | 待定 | SERIAL_CONTROL (dev 20–27) | — | — | — | planned | — | — |
| PX4 | F7/H7（bitbang 固件） | 待定 | AM32 G071 | 待定 | 待定 | SERIAL_CONTROL (dev 20–27) | — | — | — | planned | — | — |
| Direct | N/A（USB 单线适配器） | N/A | AM32 F051 | 待定 | 待定 | Direct 19200 半双工 | — | — | — | planned | — | — |
| Direct | N/A（USB 单线适配器） | N/A | AM32 G071 | 待定 | 待定 | Direct 19200 半双工 | — | — | — | planned | — | — |
| ArduPilot | 待定 | 待定 | EFM8 (BLHeli_S) | 待定 | 待定 | ArduPilot passthrough | — | — | — | planned | — | — |
| ArduPilot | 待定 | 待定 | EFM8 (Bluejay) | 待定 | 待定 | ArduPilot passthrough | — | — | — | planned | — | — |

## 刷写发布前的额外验证清单

每个宣称 `supported`（刷写）的组合必须逐项通过：

- [ ] 正常刷写后重新上电并再次识别成功
- [ ] 写页期间 WS 断开：会话进入 `orphaned`，完成当前安全原子单元
- [ ] 页校验失败：进入 `paused`，不自动继续
- [ ] 用户取消：延迟到安全边界生效
- [ ] 错误 MCU/target：在 erase 之前被拒绝
- [ ] 固件触碰 bootloader 禁写区：在 erase 之前被拒绝
- [ ] 四合一第二颗失败后批次暂停
- [ ] 飞控/ESC 电池掉电后可恢复（bootloader 仍可进入）

## 变更规则

- 任何人不得在没有附验证记录（日期、硬件、固件版本、操作日志）的情况下把状态改为
  `read-verified` 或 `supported`。
- 发现回归时立即降级为 `broken` 并链接 issue。
