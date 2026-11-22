# yt-dlp 音乐导入

Songloft JS 插件 — 通过 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 从 YouTube、Bilibili、SoundCloud 等平台导入歌单到 Songloft。

## 功能

- **歌单导入**：粘贴链接即可提取歌单元数据并导入到音乐库
- **按需播放**：导入为在线歌曲，首次播放时自动解析音频 URL 并缓存
- **下载到本地**：可选将歌曲下载为本地文件，离线可用
- **多平台支持**：支持 yt-dlp 所支持的所有平台（1000+）
- **自动去重**：相同视频不会重复导入

## 安装

在 Songloft 插件管理页面安装，或手动下载 [Releases](../../releases) 中的 `.jsplugin.zip` 文件。

### 插件源地址

```
https://raw.githubusercontent.com/hanxi/songloft-plugin-ytdlp/main/registry.json
```

在 Songloft 设置 → JS 插件 → 插件源中添加上述地址即可自动获取更新。

## 使用

1. 在插件设置页安装 yt-dlp 二进制（自动下载对应平台版本）
2. 在导入页粘贴歌单或视频链接
3. 点击「提取」获取歌曲列表
4. 选择「仅导入」或「导入并下载」，执行导入

Linux x86-64 和 ARM64 的自动安装与手动下载链接会根据服务器的 libc 选择上游二进制。如果设置页显示「无法运行」，请点「重新安装 yt-dlp」，并查看状态下方的错误详情。

自动安装会校对下载大小，并运行新文件验证版本，再替换原文件。若提示文件大小不符，可更换 GitHub 代理后重试。

在「下载管理」中可暂停、恢复或取消批次。取消会停止后续歌曲和重试；当前已开始的单首下载会继续到结束，期间显示「取消中」。已下载文件保留，批次结束后可清除记录并开始新批次。

### ARMv7 / Alpine

- ARMv7（`armv7l`，Songloft 平台字段为 `linux-arm`）使用本插件仓库同版本 Release 中的 `yt-dlp_musllinux_armv7l`，内置 Python，适用于 Alpine / musl；不支持 ARMv6 或 glibc 系统。
- 自动安装与手动下载链接都指向插件自身版本对应的标签，因此预发布也能下载，且不会误用上游的 glibc ARM 包。其他平台继续使用 yt-dlp 上游正式版。
- 预发布请从对应 Release 手动安装 `ytdlp.jsplugin.zip`，ARM 附件就绪后再在插件设置中安装 yt-dlp；普通插件源仍提供正式版。Release 说明中会更新异步构建状态，尚未就绪时安装器会提示稍后重试。
- 单文件程序需要可执行的临时目录。构建验证使用 QEMU ARMv7 和干净 Alpine 容器，不代表玩客云真机已验收。YouTube 等站点可能还需要 JS 运行时，本包不内置 Deno 或浏览器模拟依赖。

## 开发

```bash
pnpm install
pnpm run dev         # watch + 自动上传到本地 Songloft
pnpm run build       # 生成 dist/ytdlp.jsplugin.zip
pnpm run validate    # 校验 plugin.json hashes
pnpm test            # 平台选择、预发布下载与安装失败回归
pnpm run typecheck
```

### 发布

推送到 `main` 后，`Release Plugin` 按主线顺序给每个待发布的代码提交单独打包。纯文档提交和自动生成的版本提交会跳过。失败后可在 GitHub Actions 手动运行同一个工作流，从未完成的提交继续。首次启用以工作流中的 `RELEASE_BASE_SHA` 为边界，之后以 `plugin.json.releaseSource` 记录已发布源码。

版本号按北京时间生成 `YYYY.M.D.N`，每日从 `.0` 开始，同日按所有标签（含预发布）的最大序号递增。标签带 `v`。若同日已有三段日期版本，从 `.1` 开始。已经分配的标签保留。手动运行时可指定下一笔正式版的版本，也可开启 `prerelease` 为当前主线生成预发布包。

流程拆成两个 workflow：

1. `Release Plugin` 在隔离的 Git 工作树中安装锁定依赖，检查、测试并打包。每个标签指向对应源码加版本元数据的快照。Release 包含 `ytdlp.jsplugin.zip`、包内同源 `plugin.json` 和 `SHA256SUMS`，正式版随后更新主线清单。
2. `Build yt-dlp ARMv7` 根据发布工作流交接的标签和源码提交异步构建。一次推送产生多个 Release 时，每个 Release 都会获得独立构建。它解析 yt-dlp 最新正式版标签、检出源码，用固定 Python Alpine 镜像和上游锁定的 Python 依赖，通过官方 PyInstaller 入口构建 `linux/arm/v7` 单文件。无 Python、uid=1000 的 Alpine 3.24 容器验证版本、提取器、真实 HTTP 下载和 HTTPS 解析后，追加附件到对应的 Release，并更新说明中的 ARM 状态。

ARM 构建不阻塞插件发布；失败不撤销已发布插件。可在 `Build yt-dlp ARMv7` 中手动填写已有 Release 的标签重跑，成功后补齐：

- `yt-dlp_musllinux_armv7l`
- `yt-dlp-SHA256SUMS`、`yt-dlp-build.json`（上游版本与提交、插件提交、构建环境）、Python 依赖清单和许可证

预发布不会回写根目录 `plugin.json` / `package.json`，保持正式插件源不变。正式发布才同步构建后的入口、哈希、版本和下载链接。ARM 二进制通过插件安装器随插件版本更新，不使用 yt-dlp 自更新。

本地复现 ARM 构建（先检出所需 yt-dlp 正式版到工作树外目录）：

```bash
docker buildx build --platform linux/arm/v7 \
  --build-arg YTDLP_VERSION=<上游版本> \
  -f scripts/armv7/Dockerfile --output type=local,dest=/tmp/ytdlp-assets \
  /path/to/yt-dlp
node scripts/armv7/smoke.mjs /tmp/ytdlp-assets <上游版本>
```

宿主需要 Docker 的 ARM QEMU 支持；CI 会自动配置。更多源码与依赖的准确版本见 Release 附件。

## 权限

| 权限          | 用途                                   |
| ------------- | -------------------------------------- |
| `storage`     | 持久化插件设置                         |
| `command`     | 执行 yt-dlp 命令、管理二进制           |
| `songs.write` | 调用 `songs.download` 将歌曲下载到本地 |

## License

Apache-2.0 © 2026 Songloft Team
