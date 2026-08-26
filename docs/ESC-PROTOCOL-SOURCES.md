# ESC 协议来源

本文件记录当前“AM32 参数配置”实际使用的协议事实。实现为独立代码；GPL/AGPL 项目只用于核对外部行为，不复制、翻译或合并其源码。

| 协议事实 | 来源 | 代码/验证 |
|---|---|---|
| CRC16-XMODEM：poly `0x1021`、init `0x0000` | ITU-T V.41 / 公共算法 | `crc.test.ts` golden vector |
| MSP v1 帧与命令 1、2、245 | MultiWii/Betaflight 文档；ArduPilot AP_MSP/AP_BLHeli（GPLv3，仅核对行为） | `msp.test.ts`；ArduCopter 4.7.0 USB 直通实测 |
| 4-way 帧、Read `0x3A`、Write `0x3B`、ACK | BLHeliSuite 4-way 公开规范 | `fourWay.test.ts` |
| `DeviceInitFlash`：signature little-endian、interface mode 位于 byte 3 | ArduPilot AP_BLHeli（GPLv3，仅核对协议事实） | MicoAir743v2 + AM32 返回 `06 1F 02 04` |
| ArduPilot 前置条件：`SERVO_BLH_AUTO/MASK`、DShot、USB | [ArduPilot BLHeli passthrough 文档](https://ardupilot.org/copter/docs/common-blheli32-passthru.html) | UI 与服务端会话门控 |
| MAVLink `SERIAL_CONTROL` 消息 126 | [MAVLink common messages](https://mavlink.io/en/messages/common.html) | `mavlink-mappings` message definition + local codec |
| PX4 ESC device id 20–27 | [PX4 serial passthrough 文档](https://docs.px4.io/main/en/uart/serial_passthrough) | 自动化测试；HIL 待完成 |
| AM32 19200 半双工与 EEPROM 字段语义 | AM32 公开文档/固件（GPLv3，仅核对协议事实） | `layouts/am32.test.ts`；HIL 状态见兼容性文档 |

新增命令、EEPROM 字段、MCU 地址或 layout 时，必须在此补充来源、许可证边界与验证方式。未经来源确认或硬件验证的设备默认只读。
