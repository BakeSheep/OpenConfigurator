# ESC 协议来源与许可记录

本文件记录 OpenConfigurator ESC 配置功能所依赖的每一项协议事实（命令码、EEPROM 字段布局、CRC、
固件资源、测试向量）的来源与许可证。目标是保证主程序可以继续采用 MIT 许可证，并具备可审计的
代码来源。

## 记录规则

1. **功能兼容，不移植来源不清晰的实现。** 没有明确许可的参考代码（例如未附带 LICENSE 的
   `am32-firmware/am32-configurator`）只能用于理解外部行为，不允许逐行翻译或复制。
2. **AGPL 代码不得合并。** `stylesuxx/esc-configurator`（AGPL-3.0）仅作为行为参考；本仓库中的
   实现必须是根据协议事实（wire format、命令码、公开文档）的独立实现。
3. **协议事实本身不受版权保护**（命令字节值、寄存器偏移、帧格式），但其“表达”（具体代码、
   注释、结构）受保护。记录中 `Used as` 一栏区分这两者。
4. 每新增一个命令码、layout 字段或固件源，必须在下表追加一行。
5. `Verified by` 只允许填写：`Golden vector`（公开测试向量）、`Device`（真实硬件回读验证）、
   `Spec`（公开规范文档）或 `Pending`（尚未验证，禁止用于写入路径）。

## 来源记录

### 通用算法

| Item | Value/Range | Source | License | Used as | Verified by |
|---|---|---|---|---|---|
| CRC16-XMODEM | poly 0x1021, init 0x0000 | Public standard (ITU-T V.41) | N/A | Independent implementation | Golden vector (`'123456789' → 0x31C3`) |
| Intel HEX format | record types 00/01/02/04/05 | Public standard (Intel spec) | N/A | Independent implementation | Golden vector + malformed fixtures |
| RTTTL format | `name:d=N,o=N,b=N:notes` | Public de-facto standard (Nokia) | N/A | Independent implementation | Round-trip tests |

### MSP（MultiWii Serial Protocol）

| Item | Value/Range | Source | License | Used as | Verified by |
|---|---|---|---|---|---|
| MSP v1 帧格式 | `$M<`/`$M>` + size + cmd + XOR checksum | Public protocol docs (MultiWii/Betaflight wiki) | Protocol fact | Independent implementation | Golden vector (`msp.test.ts`) |
| MSP_API_VERSION | cmd 1 | Betaflight MSP docs | Protocol fact | Command id only | Pending |
| MSP_FC_VARIANT | cmd 2 | Betaflight MSP docs | Protocol fact | Command id only | Pending |
| MSP_BATTERY_STATE | cmd 130 | Betaflight MSP docs | Protocol fact | Command id only | Pending |
| MSP_MOTOR_CONFIG | cmd 131 | Betaflight MSP docs | Protocol fact | Command id only | Pending |
| MSP_SET_PASSTHROUGH | cmd 245 | Betaflight MSP docs / ArduPilot AP_MSP | Protocol fact | Command id only | Pending |

### 4-way interface（BLHeli passthrough）

| Item | Value/Range | Source | License | Used as | Verified by |
|---|---|---|---|---|---|
| 帧格式 | `0x2F` + cmd + addr(2) + param_len + params + CRC16-XMODEM | BLHeliSuite 4-way interface 公开文档 / ArduPilot AP_BLHeli 文档 | Protocol fact | Independent implementation | Golden vector (`fourWay.test.ts`)；param_len 0 表示 256 |
| cmd_InterfaceTestAlive | 0x30 | 4-way interface spec | Protocol fact | Command id only | Pending |
| cmd_ProtocolGetVersion | 0x31 | 4-way interface spec | Protocol fact | Command id only | Pending |
| cmd_InterfaceExit | 0x34 | 4-way interface spec | Protocol fact | Command id only | Pending |
| cmd_DeviceReset | 0x35 | 4-way interface spec | Protocol fact | Command id only | Pending |
| cmd_DeviceInitFlash | 0x37 | 4-way interface spec | Protocol fact | Command id only | Pending |
| cmd_DeviceEraseAll | 0x38 | 4-way interface spec | Protocol fact | Command id only | Pending |
| cmd_DevicePageErase | 0x39 | 4-way interface spec | Protocol fact | Command id only | Pending |
| cmd_DeviceRead | 0x3A | 4-way interface spec | Protocol fact | Command id only | Pending |
| cmd_DeviceWrite | 0x3B | 4-way interface spec | Protocol fact | Command id only | Pending |
| ACK codes | OK=0x00, UNKNOWN_ERROR=0x01, INVALID_CMD=0x02, INVALID_CRC=0x03, VERIFY_ERROR=0x04, INVALID_CHANNEL=0x08 | 4-way interface spec | Protocol fact | Error mapping | Golden vector (`fourWay.test.ts`) |
| DeviceInitFlash 响应字段 | signature=params[0..1]，interfaceMode=params[3]（ARMBLB=4, SiLBLB=1） | 4-way interface spec + 行为参考 | Protocol fact | 固件家族分类（仅显示，不启用写入） | Pending（偏移待真机校验，未识别一律只读） |

### ArduPilot passthrough

| Item | Value/Range | Source | License | Used as | Verified by |
|---|---|---|---|---|---|
| BLHeli passthrough 前置条件 | `SERVO_BLH_AUTO=1` 或 `SERVO_BLH_MASK`；DShot 输出；USB 串口 | <https://ardupilot.org/copter/docs/common-blheli32-passthru.html> | Public docs | Precondition checks | Spec |
| MSP-over-MAVLink 口检测 | 同一 USB 口发送 MSP 帧自动切换 | ArduPilot AP_MSP 公开文档 | Public docs | Session entry behavior | Pending |

### PX4 SERIAL_CONTROL

| Item | Value/Range | Source | License | Used as | Verified by |
|---|---|---|---|---|---|
| SERIAL_CONTROL 消息 | MAVLink msg #126 | MAVLink 公开规范 | MAVLink (MIT-licensed defs) | node-mavlink message class | Spec |
| ESC 通道 device id | SERIAL_CONTROL_DEV 20–27 (`SERIAL_CONTROL_SERIAL0..7` ESC mapping) | PX4 serial passthrough 文档 <https://docs.px4.io/main/en/uart/serial_passthrough> | Public docs | Device id range | Pending |
| 初始化约定 | 首条 `count=0` + baudrate 消息，flags `RESPOND\|EXCLUSIVE` | PX4 serial passthrough 文档 | Public docs | Session init behavior | Pending |

### AM32

| Item | Value/Range | Source | License | Used as | Verified by |
|---|---|---|---|---|---|
| Bootloader 串口参数 | 19200 baud，半双工单线，写后自回显 | AM32 公开文档 <https://am32.ca> | Public docs | Transport behavior | Pending |
| EEPROM layout（各 revision） | 见 `src/shared/esc/layouts/am32.ts` | 真实设备 EEPROM 备份 fixture（待采集）；AM32 firmware（GPLv3）仅核对字段语义，不复制代码 | Fixture: self-collected | Layout table | Pending（未验证 revision 一律只读） |
| Flash/bootloader 禁写区 | 按 MCU（F051/G071/F421/…）单独记录 | AM32 公开文档 + MCU datasheet | Public docs | Address guard | Pending |

### BLHeli_S / Bluejay（后置任务）

| Item | Value/Range | Source | License | Used as | Verified by |
|---|---|---|---|---|---|
| EFM8 地址空间/页大小 | 待记录 | SiLabs EFM8 datasheet | Public docs | Flash parameters | Pending |
| BLHeli_S EEPROM layout | 待记录 | 真实设备备份 fixture（待采集） | Fixture: self-collected | Layout table | Pending |
| Bluejay EEPROM layout | 待记录 | Bluejay 公开文档（GPLv3 项目，仅协议事实） | Public docs | Layout table | Pending |

### 固件分发源

| Item | Value/Range | Source | License | Used as | Verified by |
|---|---|---|---|---|---|
| AM32 firmware releases | GitHub Releases API | <https://github.com/am32-firmware/AM32> | GPLv3（作为独立资产分发给用户，不与本程序链接） | Firmware catalog | SHA-256 记录于目录 |
| Bluejay releases | GitHub Releases API | <https://github.com/bird-sanctuary/bluejay> | GPLv3（同上） | Firmware catalog | SHA-256 记录于目录 |
| BLHeli_S hex 仓库 | GitHub | 待确认具体仓库与许可 | TBD | Firmware catalog | Pending |
