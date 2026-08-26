# Third-Party Notices

OpenConfigurator 采用 [MIT License](LICENSE)。ESC 协议实现基于公开协议事实与独立编写的测试向量；当前产品不下载、分发或刷写第三方 ESC 固件。

## ESC 参考边界

| 项目或规范 | 许可证/性质 | 本项目用途 |
|---|---|---|
| BLHeliSuite 4-way interface | 公开协议文档 | 帧格式、命令码与 ACK 等协议事实 |
| ArduPilot AP_BLHeli / AP_MSP | GPLv3 | 核对 passthrough 行为与响应字段，不复制代码 |
| AM32 firmware / configurator | GPLv3 或仓库声明 | 核对 EEPROM 字段语义，不复制实现 |
| stylesuxx/esc-configurator | AGPL-3.0 | 仅作外部行为参考，代码不得合并 |
| MAVLink definitions | MIT-compatible | 通过 `mavlink-mappings` 使用公开消息定义 |

逐项协议来源和验证状态见 [docs/ESC-PROTOCOL-SOURCES.md](docs/ESC-PROTOCOL-SOURCES.md)。npm 运行时依赖及版本见 [package.json](package.json)，其许可证以各依赖自身声明为准。

## 结构化日志导出

| 依赖 | 许可证 | 本项目用途 |
|---|---|---|
| `@noble/hashes` | MIT | 对源日志执行增量 SHA-256，写入导出清单 |
| `@zip.js/zip.js` | BSD-3-Clause | 在浏览器中流式生成 ZIP64 结构化日志包 |

具体版本固定于 [package-lock.json](package-lock.json)，许可证全文随 npm 包保存在各依赖目录中。

## 界面素材

| 项目 | 许可证 | 本项目用途 |
|---|---|---|
| QGroundControl `resources/calibration/accel_*.png`、`src/AutoPilotPlugins/PX4/Images/Vehicle*Rotate.png` | Apache License 2.0 | 六面加速度计方位图与 PX4 罗盘六面旋转引导图，未修改 |

素材来自 [QGroundControl 加速度计素材](https://github.com/mavlink/qgroundcontrol/tree/ae7717a3d19c557fe7ca0c23dae2c8ab19c92668/resources/calibration)及 [PX4 校准素材](https://github.com/mavlink/qgroundcontrol/tree/ae7717a3d19c557fe7ca0c23dae2c8ab19c92668/src/AutoPilotPlugins/PX4/Images)，固定于提交 `ae7717a3d19c557fe7ca0c23dae2c8ab19c92668`。许可证全文随素材保存在 [`public/assets/calibration/LICENSE-APACHE-2.0.txt`](public/assets/calibration/LICENSE-APACHE-2.0.txt)。

## 飞行器配置参考数据

| 项目 | 许可证/性质 | 本项目用途 |
|---|---|---|
| QGroundControl `AirframeFactMetaData.xml`，提交 `f4d5cb0bc975294b51d050fc8878e5600e93b907` | Apache License 2.0 双许可选项 | 构建时生成 PX4 机架名称、分组、autostart ID 与输出描述目录 |
| QGroundControl 配置控制器与 QML，同一提交 | 外部行为参考 | 核对参数映射、开关分段和遥控器校准阈值；未复制 QML 或控制器代码 |

生成后的机架目录保留来源提交和许可证标识。实现细节与逐项来源见 [docs/VEHICLE-CONFIG-SOURCES.md](docs/VEHICLE-CONFIG-SOURCES.md)。
