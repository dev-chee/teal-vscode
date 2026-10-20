# Change Log

## [Unreleased]

- 支持 9 个桌面平台的原生工具链识别、托管安装与工作区运行/调试入口，覆盖本地及远程 Node.js 宿主。
- 工具链与扩展发布增加各平台真实 CLI/LSP/DAP 验收，工具链下载源统一为 `dev-chee/teal`。

## [0.1.7] - 2026-10-20

- 托管和本地工具链新增 `teal-fmt`，Windows 与 WSL 发行归档均包含四个 Teal 工具。

## [0.1.6] - 2026-10-20

- 更新 `teal-lang` Release 工具链，修复聚合值在循环重入和重复执行时的寄存器模板复用问题。

## [0.1.5] - 2026-10-19

- 使用 `teal-lang` Release 工具链，并修复 Windows 下语言服务器更新时的文件占用。

## [0.1.4] - 2026-10-17

- 选择包含目标平台归档的最新工具链 Release，避免扩展版本 Release 覆盖工具链下载源。

## [0.1.3] - 2026-10-17

- 发布托管工具链安装功能，并支持 Windows x64 与 WSL Linux x64。

## [0.1.2] - 2026-10-17

- 将 Marketplace 显示名称改为 `Teal Language for VS Code`。

## [0.1.1] - 2026-10-17

- 首次公开发布 Teal for Visual Studio Code。
- 提供 Teal/Teal Interface 语法支持、本地语言服务、运行和源码调试。
- 支持 Windows x64 本地扩展宿主和 WSL Linux x64 工作区。
