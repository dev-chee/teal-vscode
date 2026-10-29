# 发布到 Visual Studio Marketplace

插件发布由 GitLab 的 `release`（或 `release/*`）分支推送触发。流水线使用 Windows x64、Ubuntu x64（WSL）和 macOS x64 三个 Runner，为全部九个桌面目标生成内置 Teal 工具链的 VSIX。全部验证和打包成功后才自动打标签并上架；不需要手动创建版本标签。

GitHub 的 `.github/workflows/publish-marketplace.yml` 已注释自动触发，发布 job 固定跳过；原代码和原条件保留供查阅，手动入口只验收和打包。

## 版本与发布顺序

1. 推送新的 release 分支提交，父流水线先执行类型检查、Lint 和单元测试。
2. `release` trigger 取得 `vscode-release` 锁，等待整个子流水线结束。锁覆盖版本分配、Teal 构建选择、九平台打包、打 tag 和上架，避免并发分配同一版本。最终 job 另持有 `marketplace-publish` 锁，使直接重试子 job 时也保持上架串行；两个锁名称不同，避免父子互相等待。
3. 根据该分支最近的稳定 `vX.Y.Z` 标签递增 patch；首次没有历史标签时使用 `package.json.version`。候选版本还必须高于整个仓库的全部稳定版本标签；若其他分支已有更高版本，使用该全局最高版本的下一 patch，例如 `v1.2.3` 所在分支遇到全局 `v2.0.0` 时分配 `v2.0.1`。
4. 准备阶段选择 Teal 仓库指定分支最新成功的 GitLab pipeline，要求全部九个目标制品都属于该次 pipeline 和同一源码 SHA，并把版本和来源写入 `target/release.json`。单独重试准备 job 时，先通过包含 retried jobs 的 API 查询，按最早成功的 `prepare_release` job ID 恢复此文件；原制品过期或丢失时失败，不重新选择最新 Teal 构建。
5. 各平台 job 按固定 job ID 下载 Teal 的分发归档，校验并嵌入 VSIX。打包时使用 `--release-plan-file target/release.json`，先核对工具链身份，再将完整准备计划的规范化 SHA-256 指纹写入包内清单。版本只写入 CI 检出副本的 `package.json`，不额外提交版本变更。
6. 九个目标全部成功后，`publish_marketplace` 读取九个 VSIX 内的插件版本、计划指纹和工具链来源，全部与当前计划一致后才创建标注标签；创建新标签时再次检查全局版本上限。随后调用 `node scripts/publish.mjs`，调用 Marketplace 前再次验证全部包。标签标注记录插件版本、SHA、构建 pipeline 和 Teal 构建快照；已有标签必须匹配完整计划，不能只凭相同文件名或源码 SHA 放行。

例如上次为 `v0.1.7`，下一次新提交首次构建成功后生成 `v0.1.8`。失败的构建不打 tag；同一成功提交再次运行时复用原 tag 和原 Teal 快照，不再次递增，也不重新选择最新工具链。旧的排队提交若已有后继提交成功打标，会被拒绝，避免把旧源码作为更高版本上架。tag 推送本身不会触发流水线。

源代码中的 `package.json.version` 可以仍是初始版本；发布 VSIX 的实际版本以 `target/release.json` 和自动 tag 为准。不需要为了每次 patch 发布手动修改它。

## Teal 构建来源

默认来源是当前 GitLab 上的 `public-platform/teal-ai/teal` 项目、`release` 分支，可通过项目变量覆盖：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TEAL_SOURCE_PROJECT` | `public-platform/teal-ai/teal` | Teal GitLab 项目完整路径 |
| `TEAL_SOURCE_REF` | `release` | Teal 最新成功构建所在分支，例如 `release/0.1` |

插件构建不要求先发布 GitHub `toolchain-v*` Release，也不重新编译 Teal；它直接消费 Teal CI 的最新成功交叉构建结果。每个目标来自该次 pipeline 的 `build_release_*` job，文件为 `target/dist/teal-<源码包版本>-<Rust目标>.zip` 或 `.tar.gz`。缺少任何目标时失败，不用历史平台包补齐。

“最新”只在新版本准备阶段解析一次。后续各 job、准备 job 的重试和已成功版本的重试都按固定 pipeline/job ID 取包，防止构建途中来源变化。新建子流水线且该提交尚未打标时可以选择新的快照，但只能使用该子流水线的整套目标包。下载使用经过认证的 GitLab API 和 HTTPS，记录归档 SHA-256，并逐项验证包内 `manifest.json` 的文件集合、大小和 SHA-256；拒绝链接、越界路径和清单外实现源码。VSIX 包含 `teal`、`toolchain.json`、`runtime/` 及来源元数据，不包含 Rust 宿主实现源码。

包内身份记录 GitLab 项目、pipeline、job、源码 SHA 和归档摘要；不会把尚未公开的 CI 构建伪装成 GitHub 正式 Release。现有自动更新器仍从公开 GitHub Releases 更新；当 PATH 和托管工具链不可用时，默认 `latest` 设置可使用已校验的包内工具链。显式固定某个 GitHub Release 时，不会回退到其他 GitLab 构建。

Teal 源流水线和插件流水线的 job artifacts 默认保留 30 天。过期或删除的固定来源会使重建失败，不会静默换成新工具链；部分上架失败时应优先重试原流水线的发布 job。

## 三个 Runner

| 默认标签 | 宿主 | 打包目标 | 实际运行验证 |
| --- | --- | --- | --- |
| `windows` | Windows x64 | `win32-x64`、`win32-arm64` | Windows x64 协议与 VS Code 宿主测试 |
| `linux` | Ubuntu x64 / WSL | `linux-x64`、`linux-arm64`、`linux-armhf`、`alpine-x64`、`alpine-arm64` | GNU/Linux x64 协议与 VS Code 宿主测试 |
| `macos` | macOS x64 | `darwin-x64`、`darwin-arm64` | macOS x64 协议与 VS Code 宿主测试 |

标签可用 `TEAL_RUNNER_TAG_WINDOWS`、`TEAL_RUNNER_TAG_LINUX`、`TEAL_RUNNER_TAG_MACOS` 覆盖。Runner 需预装 Git 与支持 ZIP/tar.gz 的 `tar`。Unix 使用 Bash，优先使用 PATH 或 Homebrew 标准路径中的 Node.js 22 及以上版本和 npm；缺少时自动下载 Node.js 22.23.4 到 `target/ci/node/`，校验官方 SHA-256 后使用，需要 `curl` 及 `sha256sum`（Linux）或 `shasum`（macOS）。Unix job 将 pnpm 11.25.0 安装到 `target/ci/npm/`，无需全局目录写权限。Windows 使用 PowerShell，仍需预装 Node.js 22 x64 和 npm，job 自行安装 pnpm。Ubuntu/WSL 需预装 Xvfb 及 VS Code/Electron 依赖，macOS/Windows 需支持 VS Code 宿主测试。

ARM64、ARMhf 与 Alpine 目标在插件流水线中只做制品和完整性验证、打包；其交叉编译由 Teal 仓库负责。不要求 ARM Runner、Docker 或 QEMU；这些目标未在此流程执行原生宿主或模拟器测试，不能把打包成功视为运行验收通过。

## 一次性配置

在 GitLab 项目的 **Settings -> CI/CD -> Variables** 配置以下变量，均开启 Masked（支持时可选 Masked and hidden）、Protected，关闭变量展开：

| 变量 | 权限与可用范围 |
| --- | --- |
| `TEAL_GITLAB_READ_TOKEN` | 可读取 Teal 项目的 pipeline、jobs、源码版本和制品，以及插件项目自身 pipeline/jobs 和准备制品的 `read_api` token；Environment scope 为 `*`，准备与打包 jobs 需要使用 |
| `GITLAB_RELEASE_TOKEN` | 可在插件项目创建受保护标签的 `api` token；Environment scope 为 `marketplace`，只在最终 job 使用 |
| `VSCE_PAT` | Visual Studio Marketplace Publisher `dev-chee` 的发布凭据，`Marketplace -> Manage` 权限；Environment scope 为 `marketplace` |

`CI_JOB_TOKEN` 的默认 API 权限不足以枚举另一项目的 pipeline/jobs，此流程使用显式读取 token，详见 [GitLab job token 权限](https://docs.gitlab.com/ci/jobs/ci_job_token/)。创建标签使用 [Tags API](https://docs.gitlab.com/api/tags/)，不会把写入 token 放入 Git remote 或命令行。

保护 `release` 分支（以及使用到的 `release/*` 分支）和 `v*` 标签，授予发布账号及打标 token 对应账号创建标签的权限，并允许三个 Runner 执行受保护分支流水线。Protected 变量只有在受保护 ref 上可用。GitHub Secret 不会自动迁移。

## 触发与重试

本仓库 `funplus` 指向 GitLab，`origin` 指向 GitHub。先提交本次发布所需的代码和 CI 配置，然后推送：

```powershell
# HEAD 是准备发布的提交；也可在 release 分支直接 git push funplus release。
git push funplus HEAD:refs/heads/release
```

如果 Teal 的构建分支不是默认 `release`，在项目变量中设置 `TEAL_SOURCE_REF`，或在允许传入流水线变量时使用：

```powershell
git push funplus HEAD:refs/heads/release -o ci.variable="TEAL_SOURCE_REF=release/0.1"
```

不要手动推送 `v*` 标签来启动发布。网页新建 release 流水线不触发发布；失败后重试原父/子流水线对应 jobs。重试准备 job 不会重新分配版本或来源；同一次子流水线的旧目标包因此仍匹配同一指纹。升级到本门禁后，缺少包内计划指纹的旧 VSIX 必须重新打包。若标签已创建但 Marketplace 只完成部分目标，重试发布器会跳过已发布目标，继续剩余目标，保留相同版本与工具链来源。

目标集合为 `win32-x64`、`win32-arm64`、`linux-x64`、`linux-arm64`、`linux-armhf`、`alpine-x64`、`alpine-arm64`、`darwin-x64`、`darwin-arm64`。当前不发布 `web`，因为扩展执行依赖 Node.js 工作区宿主、子进程和 DAP。
