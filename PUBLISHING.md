# 发布到 Visual Studio Marketplace

本仓库使用 GitHub Actions 在版本标签推送时发布 VS Code 的全部桌面目标 VSIX。普通提交不会发布；这样可以保证每次发布都有明确且唯一的扩展版本。

## 一次性配置

1. 在 [Visual Studio Marketplace Publisher 管理页](https://marketplace.visualstudio.com/manage) 创建或选择 `dev-chee` Publisher。它必须与 `package.json` 的 `publisher` 一致。
2. 在 Azure DevOps 创建一个组织范围的 Personal Access Token，只授予 `Marketplace -> Manage` 权限。
3. 在 GitHub 仓库 `dev-chee/teal-vscode-extension` 的 **Settings -> Secrets and variables -> Actions** 中创建 Secret：
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

扩展不包含 Teal 工具链，用户按 README 配置本地工具链或执行托管安装。工具链统一发布在 `dev-chee/teal`，需要先提交并运行 Teal 源码仓库的 `Release Teal toolchain` 工作流。填写唯一 `release_tag` 和 `source_ref`，工作流将源码解析为固定 SHA，全部 9 个目标构建和协议验收成功后才创建 Release。

扩展发布会选择同一个包含全部 9 个归档的正式工具链 Release，校验 SHA-256 和 runtime 资源，再运行各平台协议测试与六个平台的 VS Code 宿主测试。缺少任意目标会阻止发布；不会混合历史版本填补缺失目标。

Actions 手动运行默认仅验收和打包，可用 `toolchain_release` 指定正式工具链标签。勾选 `publish` 时必须选择匹配 `package.json` 的扩展版本标签，发布使用 `VSCE_PAT`。部分目标已发布后的重试会跳过相同版本的目标，继续发布剩余目标。
