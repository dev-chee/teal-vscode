# 发布到 Visual Studio Marketplace

本仓库使用 GitHub Actions 在版本标签推送时发布 VS Code 的全部桌面目标 VSIX。普通提交不会发布；这样可以保证每次发布都有明确且唯一的扩展版本。

## 一次性配置

1. 在 [Visual Studio Marketplace Publisher 管理页](https://marketplace.visualstudio.com/manage) 创建或选择 `dev-chee` Publisher。它必须与 `package.json` 的 `publisher` 一致。
2. 在 Azure DevOps 创建一个组织范围的 Personal Access Token，只授予 `Marketplace -> Manage` 权限。
3. 在 GitHub 仓库 `dev-chee/teal-vscode` 的 **Settings -> Secrets and variables -> Actions** 中创建 Secret：
   - Name：`VSCE_PAT`
   - Secret：刚创建的 PAT
4. 不要把 PAT 写入仓库、命令行参数、日志或本文件。工作流只通过 `VSCE_PAT` Secret 读取它。

## 发布版本

先修改 `package.json` 的 `version`，并同步更新 `CHANGELOG.md`。提交并推送后创建同版本标签：

```powershell
git add package.json CHANGELOG.md .github/workflows/publish-marketplace.yml PUBLISHING.md
git commit -m "release: prepare VS Code Marketplace publishing"
git push origin main

# 例如 package.json 的 version 为 0.1.1
git tag v0.1.1
git push origin v0.1.1
```

标签必须严格匹配 `package.json` 的版本，例如 `v0.1.1` 对应 `0.1.1`。工作流会依次执行类型检查、Lint、单元测试、打包，然后把全部桌面目标 VSIX 发布到 Marketplace，并把 VSIX 保存为 GitHub Actions artifact。

Marketplace 发布以下全部桌面目标：`win32-x64`、`win32-arm64`、`linux-x64`、`linux-arm64`、`linux-armhf`、`alpine-x64`、`alpine-arm64`、`darwin-x64`、`darwin-arm64`。当前不发布 `web`，因为原生执行依赖 Node.js 工作区宿主、子进程和 DAP。

扩展不包含 Teal 工具链。源码仓库 `dev-chee/teal` 负责构建，公共二进制统一发布到本仓库 `dev-chee/teal-vscode` Releases。

在源码仓库的 **Settings → Secrets and variables → Actions** 配置 `TEAL_VSCODE_RELEASE_TOKEN`。令牌采用细粒度 PAT，仅选择目标仓库 `dev-chee/teal-vscode`，授予 `Contents: Read and write`；令牌只传给最后的发布步骤，不传给构建或测试步骤。源码检出使用其自己的 `GITHUB_TOKEN`。

推送稳定版本标签 `toolchain-vX.Y.Z`（例如 `toolchain-v0.1.5`），源码工作流解析标签为固定 SHA，全部 9 平台构建和协议验收成功后才上传。手动运行 `Release Teal toolchain` 时只需填写已存在的 `release_tag`，用于重试该版本。

目标 Release 先以草稿创建，标签指向目标仓库默认分支提交；发布说明和 `toolchain-release.json` 记录源码仓库、标签、SHA 和构建链接。各归档带 `.sha256` 及目标来源 JSON。上传完成后重新核对所有平台和 GitHub 资产摘要，再公开草稿。同源码草稿可以重传；同源码完整正式版本可安全重试；不同源码占用同一标签时拒绝覆盖。

公共工具链 Release 使用 `runtime-sources-v1`：平台归档仅包含一个 `teal` 可执行文件、`toolchain.json`、`manifest.json` 和外置 `runtime/` 资源。`runtime/packages` 中的标准包 `.tl`/`.tli`、包清单、配置和模板随包分发；Rust 等宿主实现源码、Cargo 构建输入、脚本、测试、符号链接和调试符号不得包含。构建上传使用明确文件名，发布器检查 ZIP/tar.gz 内部文件和摘要，拒绝清单外资产；已有草稿若不符合该格式会停止发布，保留草稿供人工处理。来源 JSON 和 SHA-256 校验文件仅记录身份与完整性，不包含源码。GitHub 自动源码归档关联分发仓库的标签，不指向 Teal 语言源码仓库。此限制不改变 VS Code 扩展自身的正常发布内容。

首次上线顺序：先配置源码仓库 Secret，再发布一个完整 9 平台工具链版本，最后通过现有 `v*` 标签流程发布包含自动更新器的插件版本。后续二进制更新沿用 `toolchain-v*`，不要求同步升级插件版本。历史不完整 Release 不会被选为 `latest`。

扩展发布会选择同一个包含全部 9 个归档的正式工具链 Release，校验归档与根目录清单中各文件的 SHA-256，再运行各平台协议测试与六个平台的 VS Code 宿主测试。缺少任意目标会阻止发布；不会混合历史版本填补缺失目标。旧的多二进制或纯二进制分发包不再通过安装校验，需要发布新的 `runtime-sources-v1` 工具链版本。

Actions 手动运行默认仅验收和打包，可用 `toolchain_release` 指定正式工具链标签。勾选 `publish` 时必须选择匹配 `package.json` 的扩展版本标签，发布使用 `VSCE_PAT`。部分目标已发布后的重试会跳过相同版本的目标，继续发布剩余目标。
