#!/usr/bin/env bash
# 必须 source，使 Node 与工作区内 pnpm 的 PATH 对当前 job 后续命令生效。
set -e

: "${CI_PROJECT_DIR:?CI_PROJECT_DIR is required}"
teal_ci_root="$CI_PROJECT_DIR/target/ci"
export PATH="$teal_ci_root/npm/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
    && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    return 0
fi

teal_node_version=22.23.4
case "$(uname -s)" in
    Linux) teal_node_os=linux ;;
    Darwin) teal_node_os=darwin ;;
    *) echo 'Unsupported Node.js Runner OS.' >&2; return 1 ;;
esac
case "$(uname -m)" in
    x86_64) teal_node_arch=x64 ;;
    arm64|aarch64) teal_node_arch=arm64 ;;
    *) echo 'Unsupported Node.js Runner architecture.' >&2; return 1 ;;
esac

teal_node_dist="node-v$teal_node_version-$teal_node_os-$teal_node_arch"
teal_node_install="$teal_ci_root/node/$teal_node_dist"
export PATH="$teal_node_install/bin:$PATH"
if [ ! -x "$teal_node_install/bin/node" ] || [ ! -f "$teal_node_install/bin/npm" ]; then
    mkdir -p "$teal_ci_root/node"
    (
        teal_node_work=$(mktemp -d "$teal_ci_root/node/download.XXXXXX")
        trap 'rm -rf "$teal_node_work"' EXIT
        teal_node_base="https://nodejs.org/dist/v$teal_node_version"
        curl --fail --silent --show-error --location --retry 3 \
            --output "$teal_node_work/$teal_node_dist.tar.gz" "$teal_node_base/$teal_node_dist.tar.gz"
        curl --fail --silent --show-error --location --retry 3 \
            --output "$teal_node_work/SHASUMS256.txt" "$teal_node_base/SHASUMS256.txt"
        cd "$teal_node_work"
        grep "  $teal_node_dist.tar.gz\$" SHASUMS256.txt > selected.sha256
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum -c selected.sha256
        else
            shasum -a 256 -c selected.sha256
        fi
        tar -xzf "$teal_node_dist.tar.gz"
        mv "$teal_node_dist" "$teal_node_install"
    )
fi
