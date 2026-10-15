# Teal for Visual Studio Code

为 Teal 提供本地语言服务、终端运行和源码调试。支持 **Windows x64 本地桌面和 WSL Linux x64 工作区，VS Code 1.91 或更新版本**。

## 安装与工具链

通过 VS Code 的“扩展：从 VSIX 安装”选择构建生成的 `target/teal-vscode-0.1.0.vsix`，然后打开 `.tl` 文件。

插件不包含或下载工具链。先在 Teal 源码仓库构建：

```powershell
cargo build --locked --package teal-lang --bin teal --bin teal-lsp --bin teal-dap
```

在 VS Code 设置中搜索 `teal.toolchain.path`，填写构建输出的**绝对目录**，例如：

```json
{
    "teal.toolchain.path": "D:\\teal-lang\\target\\debug"
}
```

请在 `D:\teal-lang` 中执行构建命令，且使用同次构建的三个工具。该目录应包含 `teal.exe`、`teal-lsp.exe`、`teal-dap.exe`。也可使用带完整 `runtime` 资源的 Teal 分发目录。使用集成终端调试时，工具链必须包含本项目配套的 DAP `console` 支持。

配置为空时，按 PATH 顺序寻找第一个包含全部三项工具的目录；没有完整目录时使用第一个包含至少一项工具的目录。缺少工具仅停用对应功能，不跨目录拼接版本。显式目录无效时直接提示，不回退 PATH。PATH 中的空项或相对目录不参与查找；变更系统 PATH 后需要重启 VS Code。

插件仅在受信任工作区启动进程。未受信任时仍可使用语法高亮、括号和代码片段。WSL 中扩展运行在工作区的 Linux 扩展宿主，使用 Linux 工具链；暂不支持其他 Remote 类型、浏览器及虚拟文件系统。

## WSL 安装

在连接到 WSL 的 VS Code 窗口中，把扩展安装到对应的 WSL 发行版。工具链也需要在 WSL 内构建：

```bash
cd /mnt/d/teal-lang
cargo build --locked --package teal-lang --bin teal --bin teal-lsp --bin teal-dap
```

在 WSL 远程设置中配置：

```json
{
    "teal.toolchain.path": "/mnt/d/teal-lang/target/debug"
}
```

该目录必须包含具有执行权限的 Linux `teal`、`teal-lsp`、`teal-dap`。WSL 配置使用 Linux 路径，不能填写 `D:\teal-lang` 或使用 Windows `.exe` 工具链。运行和集成终端调试均在 WSL 内执行。

## 编辑

提供补全、诊断、悬停、签名帮助、定义、引用、重命名、文档及工作区符号、格式化和语义高亮。语言行为完全由本地 `teal-lsp` 决定；格式化固定使用四空格和 LF，语法不完整时可能返回空编辑。

`teal.lsp.entryFiles` 接受根分析文件数组，相对路径以所属工作区文件夹为基准；工作区外的文件使用父目录。留空时由服务端识别顶层 `fn main()` 或 `task main()`。使用现有 `entryFiles`，不使用已移除的 `entryPoints`。

每个含已打开 Teal 文档的工作区文件夹有独立语言服务器。嵌套工作区按文档实际归属隔离；打开或关闭文档时重新注册精确文档范围。工作区外的已保存文件按父目录管理，未保存的新文件需要先保存。

由于服务器在初始化时扫描磁盘，未打开的 `.tl` 文件创建、修改或删除后，插件会防抖重启对应服务器以刷新索引。已打开文件的编辑通过 LSP 增量同步给所属客户端；保存嵌套工作区的文件时，包含该路径但不负责同步该文档的父客户端也会刷新磁盘索引。设置或工作区目录变化会重启受影响的客户端。

命令面板中提供：

- **Teal: 重启语言服务器**：工具链更新或服务器退出后重新连接。
- **Teal: 显示日志**：查看启动路径、协议及错误。
- **Teal: 配置工具链**：打开插件设置。

`teal.trace.server` 可选 `off`、`messages`、`verbose`，默认关闭协议跟踪；详细跟踪可能包含正在编辑的源码。

## 运行

点击编辑器右上角运行按钮，或执行 **Teal: 运行当前文件**。插件先保存当前文件，再通过 VS Code Task 在集成终端中执行 `teal run`，可使用标准输入。工作目录为所属工作区文件夹；工作区外文件使用父目录。

```json
{
    "teal.run.options": ["--tier", "hosted", "--permission-file", "permissions.toml"],
    "teal.run.args": ["first argument", "中文参数"]
}
```

`options` 是 CLI 选项，不包含程序文件或 `--`；`args` 是程序参数。插件以独立参数传递，路径或参数中的空格不需要额外添加引号。这些设置不进行 `${...}` 变量替换。`--tier` 可选 `embedded`、`hosted`、`agentic`，只控制可用功能。权限由工具链的工作区配置或 `--permission-file` 指定的 TOML 规则决定，插件不会自动增加权限。相对权限文件路径以运行工作目录为基准。

## 调试

执行 **Teal: 调试当前文件**，或在“运行和调试”中选择 Teal。也可建立 `.vscode/launch.json`：

```json
{
    "version": "0.2.0",
    "configurations": [{
        "type": "teal",
        "request": "launch",
        "name": "Teal: Launch",
        "program": "${file}",
        "cwd": "${workspaceFolder}",
        "args": [],
        "console": "integratedTerminal",
        "stopOnEntry": false,
        "tier": "agentic"
    }]
}
```

支持断点、继续/暂停、单步进入/越过/跳出、调用栈、局部变量、复合值展开、监视、变量修改及未处理 RuntimeError 的异常断点。`T | Error` 是普通返回值，不触发异常断点。`console` 可选 `integratedTerminal` 或 `externalTerminal`；插件默认使用集成终端，调试进程的输入输出属于该终端。

Launch 支持 `tier`（`embedded`、`hosted`、`agentic`，省略时默认 `agentic`）、`permissionFile`、lint 数组 `allow`/`warn`/`deny`/`forbid`，以及 `compilerDebug`。`permissionFile` 指向已有的权限规则 TOML 文件，相对路径以 `cwd` 为基准；格式和规则由当前工具链校验。未指定时使用工具链的工作区权限配置。`allow` 等数组仅配置 lint，不授予宿主权限。DAP 没有批准交互通道，需要询问的操作会被拒绝。

旧 `runtimeProfile` 已移除，请改为 `tier`；`core`/`native`/`web` 不是有效层级。旧 `allowCapabilities`、`allowReadFiles`、`allowReadDirectories`、`allowWriteFiles`、`allowWriteDirectories`、`allowExecutables`、`allowEnvironment` 已移除，请改用 `permissionFile`。扩展会明确拒绝旧字段，不进行隐式转换。CLI 的旧 `--runtime-profile` 也应改为 `--tier`。

入口由 `fn main()` 或 `task main()` 决定，不支持旧 `entry`；服务端不支持的 `env` 也不接受。调试固定关闭优化并生成调试信息。求值受服务端限制，不能通过监视表达式调用用户函数、宿主或 FFI。不调试运行请使用插件运行命令，而非 Ctrl+F5。

### Attach

先使用同一工具链在目标环境启动 debuggee：

```powershell
teal-dap --debuggee --listen 127.0.0.1:4711 --token YOUR_RANDOM_SECRET --program program.tl
```

然后使用以下配置，运行时输入对应 token：

```json
{
    "version": "0.2.0",
    "configurations": [{
        "type": "teal",
        "request": "attach",
        "name": "Teal: Attach",
        "host": "127.0.0.1",
        "port": 4711,
        "token": "${input:tealDebugToken}"
    }],
    "inputs": [{
        "id": "tealDebugToken",
        "type": "promptString",
        "description": "Teal debuggee token",
        "password": true
    }]
}
```

`host` 必须是 IP 地址。Attach 线路有 token 认证但没有 TLS，远程连接应使用 SSH 隧道；插件不提供远程源码路径映射。插件不记录调试 token。

## 开发与验证

需要 Node.js 22.13+ 和 pnpm 11。依赖版本记录在 `pnpm-lock.yaml`。

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test:unit
$env:TEAL_TOOLCHAIN_PATH = 'D:\teal-lang\target\debug'
$env:VSCODE_EXECUTABLE_PATH = 'C:\Program Files\Microsoft VS Code\Code.exe'
pnpm test
pnpm run package
```

`pnpm run test:unit` 在 Windows/Linux 均可运行，覆盖配置校验、文档保存、工具链解析和 LSP 会话调度，不启动 VS Code，也不要求 Teal 二进制。`pnpm test` 需要 Windows x64 桌面环境。测试前将两个环境变量改成实际路径，并先从本次 Teal 源码构建工具链；测试使用隔离的 VS Code 配置目录。在源码目录按 F5 启动扩展开发宿主，在新窗口中配置本地工具链路径。`pnpm run watch` 用于持续构建。打包只包含捆绑后的扩展代码、语言资源和文档，工具链二进制不进入 VSIX；依赖许可保存在 `THIRD_PARTY_NOTICES.md`。

在 WSL 中验证真实工具链：

```bash
TEAL_TOOLCHAIN_PATH=/mnt/d/teal-lang/target/debug pnpm run test:toolchain
```

`test:toolchain` 在 Windows/Linux 均可运行，覆盖 CLI 参数与输入、嵌套工作区 LSP 刷新、DAP 启动/暂停/继续；它不替代 VS Code 扩展宿主端到端测试。测试入口会重新编译并清理旧测试产物，避免已删除的测试继续运行。

## 代码结构

- `extension.ts` 注册命令和扩展生命周期；`environment.ts` 检查宿主、信任和工具链。
- `languageClient.ts` 适配 VS Code 文档、事件、文件监视器和语言客户端；`languageSessions.ts` 独立管理会话、刷新队列和符号归属。
- `execution.ts` 适配运行任务和调试接口；`configuration.ts`、`debugOptions.ts` 校验并归一化配置；`documents.ts` 负责源码文档选择和保存。
- `toolchain.ts`、`platform.ts` 处理工具发现和平台路径规则；`reporting.ts` 集中处理日志、通知和命令错误。
- 核心单测直接调用这些模块；`toolchain.integration.ts` 通过标准协议连接真实工具，编辑器交互测试保留在 `extensionHost.test.ts`。

测试环境与实际验收结果见测试入口及 `target/test-gate/local-vscode/` 下生成的报告；报告目录和 VSIX 是本地产物，不纳入 Git。发布、下载和自动更新留待后续实现。
