# Teal VS Code 扩展发布

发布配置、Runner 和凭据要求见 [PUBLISHING.md](PUBLISHING.md)。GitLab 远端为 `funplus`，GitHub 远端为 `origin`。

1. 发布前核对 GitLab 上的 `main`、`release` 和稳定版本标签。确认 [.gitlab/release.yml](.gitlab/release.yml) 的 `TEAL_SOURCE_TAG` 指向本次要内置的上游 Teal 发布，且该发布记录了同一源码提交和流水线的九个平台制品。
2. 核对用户要求的扩展版本与 [CI 版本分配逻辑](scripts/gitlab-release-core.mjs)。首次发布使用 `package.json.version`，后续发布按 GitLab 上的稳定标签递增 patch。显式指定版本时，先确认版本分配逻辑会生成该版本，并更新对应的变更日志。
3. 正式发布时，将准备好的提交推送到 GitLab 的 `release`。推送会触发父流水线及发布子流水线，由 CI 创建标注标签并上架。

   ```powershell
   git push funplus HEAD:refs/heads/release
   ```

4. 跟进父流水线的 `verify` 和子流水线的 `prepare_release`。从 `target/release.json` 核对扩展版本、提交 SHA、上游 Teal 版本、流水线及九个 job ID。发布任务 `publish_marketplace` 要等九个 VSIX 都打包成功才会运行。Windows x64、Linux x64 和 macOS x64 同时执行原生测试。
5. CI 上传成功后，通过 Marketplace 的公开目录确认目标版本的九个平台均已通过验证并可用。以 [平台清单](src/toolchain-targets.json) 为准。查询 `extensionquery` 时使用 `IncludeVersions` 和 `ExcludeNonValidated`（`flags: 33`）。发布后台显示 `Verifying` 时继续等待。

失败时先读失败 job 的原始日志。可恢复的构建或上传失败优先重试原来的发布子流水线中的对应 job，沿用原发布计划。部分平台已上传时，重试原 `publish_marketplace` job，发布脚本会跳过已上传的目标。若修复需要推送新提交，先核对旧流水线和 Marketplace 的状态，再取消已被替代且尚未发布的运行中流水线，避免连续触发两个版本。保留已有的标注发布标签。

排查宿主测试时，Windows 检出清理依赖 [.gitlab/common.yml](.gitlab/common.yml) 的 `core.longPaths`，macOS 启动新版 VS Code 依赖 `@vscode/test-electron` 3.1.0 或更新版本，Linux x64 在未指定测试宿主或下载缓存时使用独立的临时下载目录。以 CI 日志确认问题发生在检出、下载解压还是宿主测试阶段。

需要将发布改动同步回 `main` 时，合入已发布的 `release` 提交，并仅推送 `main` 到 `funplus`。确认远端 `main` 包含版本更新和 CI 修复，且发布标签仍指向原提交。
