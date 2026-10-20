# Teal for Visual Studio Code

为 Teal 提供本地语言服务、终端运行和源码调试。面向 **Windows、Linux、macOS 的 9 个桌面目标，VS Code 1.91 或更新版本**。本地、WSL、Remote SSH、Dev Containers 与 Codespaces 的 Node.js 工作区宿主使用该宿主对应的原生工具链。

## 安装与工具链

通过 VS Code 的“扩展：从 VSIX 安装”选择构建生成的 VSIX，然后打开 `.tl` 文件。

`pnpm run package:all` 生成全部 9 个平台的 VSIX；`pnpm run package --target darwin-arm64` 生成单个平台包。`pnpm run package` 仍生成通用包，`pnpm run package:windows` 生成 Windows x64 包。

插件不会在激活时静默下载工具链。可以先在 Teal 源码仓库构建：

```powershell
cargo build --release --locked --package teal-lang --bin teal --bin teal-lsp --bin teal-dap --bin teal-fmt
```

在 VS Code 设置中搜索 `teal.toolchain.path`，填写构建输出的**绝对目录**，例如：

```json
{
    "teal.toolchain.path": "D:\\teal-lang\\target\\release"
}
```

请在 `D:\teal-lang` 中执行构建命令，且使用同次构建的四个工具。该目录应包含 `teal.exe`、`teal-lsp.exe`、`teal-dap.exe`、`teal-fmt.exe`。也可使用带完整 `runtime` 资源的 Teal 分发目录。使用集成终端调试时，工具链必须包含本项目配套的 DAP `console` 支持。

配置为空时，按 PATH 顺序寻找第一个包含全部四项工具的目录；没有完整目录时使用第一个包含至少一项工具的目录。缺少工具仅停用对应功能，不跨目录拼接版本。显式目录无效时直接提示，不回退 PATH。PATH 中的空项或相对目录不参与查找；变更系统 PATH 后需要重启 VS Code。

如果没有找到显式目录或 PATH 工具链，在受信任工作区执行 **Teal: 安装 Teal 工具链**。命令从 `dev-chee/teal` 的公开 GitHub Release 下载当前宿主对应的完整发行归档，并校验 GitHub 提供的 SHA-256 digest。归档内必须包含完整运行时和以下四个入口：

| 平台 | 发行归档 |
| --- | --- |
| Windows x64 / ARM64 | `teal-win32-x64.zip` / `teal-win32-arm64.zip` |
| Linux glibc x64 / ARM64 / ARMv7 hard-float | `teal-linux-x64.tar.gz` / `teal-linux-arm64.tar.gz` / `teal-linux-armhf.tar.gz` |
| Alpine musl x64 / ARM64 | `teal-alpine-x64.tar.gz` / `teal-alpine-arm64.tar.gz` |
| macOS Intel / Apple Silicon | `teal-darwin-x64.tar.gz` / `teal-darwin-arm64.tar.gz` |

平台按扩展宿主的操作系统、架构和 libc/ARM ABI 选择；无法确认 ABI 时仍可配置本地工具链，但不会猜测托管归档。下载源尚未发布对应平台时，安装会明确失败，不下载其他架构代替。

托管工具链安装到扩展宿主的全局存储目录。`teal.toolchain.path` 始终优先；空配置时优先使用完整 PATH 工具链，再使用已安装的托管工具链。`teal.toolchain.release` 默认为 `latest`，与 CI 共用分页和完整正式 Release 筛选规则；固定标签也必须包含全部 9 个目标归档。重新执行安装会先解析 Release，再按解析版本复用缓存，避免 `latest` 永久停留旧版本。下载源必须提供对应平台归档及 SHA-256 digest，归档必须包含完整发行目录和四个入口，否则安装会失败并保持现有工具链不变。

插件仅在受信任工作区启动进程。未受信任时仍可使用语法高亮、括号和代码片段。远程工作区中扩展运行在工作区宿主，工具链、源码路径和终端均位于该宿主。浏览器连接 Codespaces 时使用远程 Node.js 宿主；纯浏览器宿主和虚拟文件系统暂不支持原生进程。

## WSL 安装

在连接到 WSL 的 VS Code 窗口中，把扩展安装到对应的 WSL 发行版。工具链也需要在 WSL 内构建：

```bash
cd /mnt/d/teal
cargo build --release --locked --package teal-lang --bin teal --bin teal-lsp --bin teal-dap --bin teal-fmt
```

在 WSL 远程设置中配置：

```json
{
    "teal.toolchain.path": "/mnt/d/teal-lang/target/release"
}
```

该目录必须包含具有执行权限的 Linux `teal`、`teal-lsp`、`teal-dap`、`teal-fmt`。WSL 配置使用 Linux 路径，不能填写 `D:\teal-lang` 或使用 Windows `.exe` 工具链。运行和集成终端调试均在 WSL 内执行；托管安装也发生在 WSL 扩展宿主内。

## 编辑

`.tl` 使用 Teal 语言服务；`.tli`（包括 `builtin.tli`、`builtins.tli`）使用独立的 Teal Interface 声明高亮，支持 `builtin`、泛型、函数和 task 签名。接口文件不作为可执行源码提交给 LSP，也不显示运行/调试按钮。

无需工具链即可获得静态语法高亮：支持 `@optimization` 等配置属性、自定义及限定名属性、`reflect(...).@Attribute` 投影、函数和类型声明名、常量声明、命名空间、`self`、通配符 `_`，以及字符串插值中的变量和字段路径。实际颜色由主题决定；启用语义高亮后，语言服务器返回的分类可能覆盖静态颜色。

提供补全、诊断、悬停、签名帮助、定义、引用、重命名、文档及工作区符号、格式化和语义高亮。语言行为完全由本地 `teal-lsp` 决定；格式化固定使用四空格和 LF，语法不完整时可能返回空编辑。

配套的 `teal-lsp` 区分属性、函数与方法、参数、字段、枚举成员、类型和泛型参数，并标记常量与声明；字符串、插值及转义继续使用静态高亮。服务端更新需要重新构建对应环境的 `teal-lsp`，然后执行 **Teal: 重启语言服务器**；仅更新扩展不会替换本地工具链。

Windows 本地启动语言服务器前会将 `teal-lsp.exe` 复制到临时目录再运行，因此 `teal-lang\target\release` 中的文件不会被语言服务器进程占用，构建期间可以直接替换它。

`teal.lsp.entryFiles` 接受根分析文件数组，相对路径以所属工作区文件夹为基准；工作区外的文件使用父目录。留空时由服务端识别顶层 `fn main()` 或 `task main()`。使用现有 `entryFiles`，不使用已移除的 `entryPoints`。

每个含已打开 Teal 文档的工作区文件夹有独立语言服务器。嵌套工作区按文档实际归属隔离；打开或关闭文档时重新注册精确文档范围。工作区外的已保存文件按父目录管理，未保存的新文件需要先保存。

由于服务器在初始化时扫描磁盘，未打开的 `.tl` 文件创建、修改或删除后，插件会防抖重启对应服务器以刷新索引。已打开文件的编辑通过 LSP 增量同步给所属客户端；保存嵌套工作区的文件时，包含该路径但不负责同步该文档的父客户端也会刷新磁盘索引。设置或工作区目录变化会重启受影响的客户端。

命令面板中提供：

- **Teal: 重启语言服务器**：工具链更新或服务器退出后重新连接。
- **Teal: 安装 Teal 工具链**：在受信任的 Windows x64 或 WSL Linux x64 扩展宿主中下载并校验托管发行版。
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
$env:TEAL_TOOLCHAIN_PATH = 'D:\teal-lang\target\release'
$env:VSCODE_EXECUTABLE_PATH = 'C:\Program Files\Microsoft VS Code\Code.exe'
pnpm test
pnpm run package
```

`pnpm run test:unit` 在 Windows/Linux/macOS 均可运行，覆盖配置校验、文档保存、工具链解析和 LSP 会话调度，不启动 VS Code，也不要求 Teal 二进制。`pnpm test` 支持 Windows/Linux/macOS x64 与 ARM64；Linux 无图形环境时使用 `xvfb-run --auto-servernum pnpm test`。测试前将两个环境变量改成实际路径，并先从本次 Teal 源码构建工具链；测试使用隔离的 VS Code 配置目录。在源码目录按 F5 启动扩展开发宿主，在新窗口中配置本地工具链路径。`pnpm run watch` 用于持续构建。打包只包含捆绑后的扩展代码、语言资源和文档，工具链二进制不进入 VSIX；依赖许可保存在 `THIRD_PARTY_NOTICES.md`。

在 WSL 中验证真实工具链：

```bash
TEAL_TOOLCHAIN_PATH=/mnt/d/teal-lang/target/release pnpm run test:toolchain
```

`test:toolchain` 在全部目标的原生或模拟执行环境均可运行，覆盖 CLI 参数与输入、嵌套工作区 LSP 刷新、DAP 启动/暂停/继续；它不替代 VS Code 扩展宿主端到端测试。测试入口会重新编译并清理旧测试产物，避免已删除的测试继续运行。

## 代码结构

- `extension.ts` 注册命令和扩展生命周期；`environment.ts` 检查宿主、信任和工具链。
- `languageClient.ts` 适配 VS Code 文档、事件、文件监视器和语言客户端；`languageSessions.ts` 独立管理会话、刷新队列和符号归属。
- `execution.ts` 适配运行任务和调试接口；`configuration.ts`、`debugOptions.ts` 校验并归一化配置；`documents.ts` 负责源码文档选择和保存。
- `toolchain.ts`、`platform.ts` 处理工具发现和平台路径规则；`reporting.ts` 集中处理日志、通知和命令错误。
- 核心单测直接调用这些模块；`toolchain.integration.ts` 通过标准协议连接真实工具，编辑器交互测试保留在 `extensionHost.test.ts`。

测试环境与实际验收结果见测试入口及 `target/test-gate/local-vscode/` 下生成的报告；报告目录和 VSIX 是本地产物，不纳入 Git。发布流程见 [`PUBLISHING.md`](PUBLISHING.md)，向 GitHub 推送匹配 `package.json` 版本的 `v*` 标签即可触发 Marketplace 发布。

macOS 中，由 Teal 程序通过 Host 启动的原生 Mach-O 进程使用冻结的私有执行镜像；可执行文件相对资源和动态库路径需要显式配置。VS Code 直接启动工具链的路径保持不变，具体约束见 [Host 文档](https://github.com/dev-chee/teal/blob/main/crates/teal-host/README.md)。

## 全平台 CI

Teal 源码仓库的 `release-toolchain.yml` 固定同一源码 SHA，构建并验证全部 9 个目标。扩展仓库的 `publish-marketplace.yml` 只选择包含全部目标归档的同一个正式 Release，校验归档及 runtime 文件摘要，并执行平台单元测试和真实 CLI/LSP/DAP 协议测试。

GNU/Linux 归档基于 Ubuntu 22.04（glibc 2.35），Alpine 归档基于 Alpine 3.22。Windows、Linux、macOS 的 x64/ARM64 还运行 VS Code 宿主测试，覆盖集成终端调试、单步、变量、运行输入和 attach。CI 不启动外部终端与完整多根工作区交互测试；本地 `pnpm test` 可运行完整集合。Alpine 在对应架构容器中验证协议，ARMhf 在 QEMU 容器中验证，后者不等同于真实 ARMhf 机器验收。平台发布支持不代表这些尚未执行的 CI 检查已通过。
