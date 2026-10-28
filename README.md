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

### ARMv7 / Alpine

- ARMv7（`armv7l`，Songloft 平台字段为 `linux-arm`）使用本插件仓库同版本 Release 中的 `yt-dlp_musllinux_armv7l`，内置 Python，适用于 Alpine / musl；不支持 ARMv6 或 glibc 系统。
- 自动安装与手动下载链接都指向插件自身版本对应的标签，因此预发布也能下载，且不会误用上游的 glibc ARM 包。其他平台继续使用 yt-dlp 上游正式版。
- 预发布请从对应 Release 手动安装 `ytdlp.jsplugin.zip`，再在插件设置中安装 yt-dlp；普通插件源仍提供正式版。
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

在 GitHub Actions 手动运行 `Release Plugin`，填写新的 `Y.M.D` 版本号（留空取当天日期）。`prerelease` 默认开启，Release 标签仍为 `vY.M.D`；同一版本不覆盖已有 Release。

每次发布都会解析 yt-dlp 最新正式版标签，检出该版本源码，使用固定 Python Alpine 镜像和上游锁定的 Python 依赖，在 `linux/arm/v7` 下通过官方 PyInstaller 入口构建单文件。CI 在不安装 Python、uid=1000 的 Alpine 3.24 容器中检查版本、提取器、真实 HTTP 音频下载及 HTTPS 解析，通过后将以下文件放入同一个 Release：

- `ytdlp.jsplugin.zip` 与包内同源的 `plugin.json`
- `yt-dlp_musllinux_armv7l`
- `SHA256SUMS`、`yt-dlp-build.json`（上游版本与提交、插件提交、构建环境）、Python 依赖清单和许可证

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
