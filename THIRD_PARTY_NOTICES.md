# Third-Party Notices

OpenConfigurator 采用 [MIT License](LICENSE)。ESC 协议实现基于公开协议事实与独立编写的测试向量；当前产品不下载、分发或刷写第三方 ESC 固件。

## ESC 参考边界

| 项目或规范 | 许可证/性质 | 本项目用途 |
|---|---|---|
| BLHeliSuite 4-way interface | 公开协议文档 | 帧格式、命令码与 ACK 等协议事实 |
| ArduPilot AP_BLHeli / AP_MSP | GPLv3 | 核对 passthrough 行为与响应字段，不复制代码 |
| AM32 firmware / configurator | GPLv3 或仓库声明 | 核对 EEPROM 字段语义，不复制实现 |
| stylesuxx/esc-configurator | AGPL-3.0 | 仅作外部行为参考，代码不得合并 |
| MAVLink definitions | MIT-compatible | 通过 `node-mavlink` 使用公开消息定义 |

逐项协议来源和验证状态见 [docs/ESC-PROTOCOL-SOURCES.md](docs/ESC-PROTOCOL-SOURCES.md)。npm 运行时依赖及版本见 [package.json](package.json)，其许可证以各依赖自身声明为准。
