# Third-Party Notices

OpenConfigurator 采用 [MIT License](LICENSE)。本文件记录 ESC 配置功能相关的第三方项目、
其许可证，以及本项目对它们的使用方式。协议来源的逐条记录见
[docs/ESC-PROTOCOL-SOURCES.md](docs/ESC-PROTOCOL-SOURCES.md)。

## 行为参考（未复制任何代码）

以下项目仅作为**外部行为参考**（观察其与 ESC 的交互方式、功能范围与 UI 语义）。本仓库中的
ESC 协议实现均为基于公开协议事实（帧格式、命令码、公开文档）的独立实现，未复制、翻译或改写
下列项目的源码：

| 项目 | 许可证 | 使用方式 |
|---|---|---|
| [stylesuxx/esc-configurator](https://github.com/stylesuxx/esc-configurator) | AGPL-3.0 | 功能范围与行为参考。AGPL 代码不得合并进本 MIT 项目。 |
| [am32-firmware/am32-configurator](https://github.com/am32-firmware/am32-configurator) | 仓库未见明确 LICENSE | 功能范围与行为参考。来源不清晰，禁止逐行翻译或复制。 |
| [AM32 firmware](https://github.com/am32-firmware/AM32) | GPLv3 | 仅核对 EEPROM 字段语义等协议事实，不复制代码；固件二进制作为独立资产经固件目录分发给用户，不与本程序链接。 |
| [bird-sanctuary/bluejay](https://github.com/bird-sanctuary/bluejay) | GPLv3 | 同上：协议事实核对与固件资产分发。 |
| BLHeliSuite 4-way interface 文档 | 公开文档 | 4-way 帧格式与命令码的协议事实来源。 |

## 固件资产分发说明

固件目录功能从上述固件项目的 GitHub Releases 拉取 **用户选择的** 固件二进制并转发给用户
设备。这些二进制保持其原始许可证（GPLv3 等），OpenConfigurator 不修改、不静态或动态链接
这些固件，仅做完整性校验（SHA-256）后传输。目录中为每个资产记录 source URL、release/tag、
license、size 与 SHA-256。

## 运行时依赖

运行时 npm 依赖的许可证以各包的 LICENSE 声明为准（React、Express、ws、serialport、
node-mavlink、zustand 等，均为 MIT/Apache-2.0 兼容许可）。完整依赖清单见
[package.json](package.json)。
