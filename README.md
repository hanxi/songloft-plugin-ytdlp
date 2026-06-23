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

## 使用

1. 在插件设置页安装 yt-dlp 二进制（自动下载对应平台版本）
2. 在导入页粘贴歌单或视频链接
3. 点击「提取」获取歌曲列表
4. 选择「仅导入」或「导入并下载」，执行导入

## 开发

```bash
pnpm install
pnpm run dev         # watch + 自动上传到本地 Songloft
pnpm run build       # 生成 dist/ytdlp.jsplugin.zip
pnpm run validate    # 校验 plugin.json hashes
```

## 权限

| 权限 | 用途 |
|------|------|
| `storage` | 持久化插件设置 |
| `command` | 执行 yt-dlp 命令、管理二进制 |
| `songs.write` | 调用 `songs.download` 将歌曲下载到本地 |

## License

Apache-2.0 © 2026 Songloft Team
