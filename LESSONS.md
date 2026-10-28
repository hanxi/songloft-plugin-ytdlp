# 开发经验

与 [英文版](LESSONS.en.md) 同步；公共宿主规则见主仓库的 `AGENTS.md`。

## ARM-001：ARMv7 产物必须匹配 libc，安装成功必须以实际执行为准

- 范围：本插件二进制选择、安装与发布；songloft-org/songloft#544。基线 `4ccac5d7aecce0ead2c3384afbefe8bb6c2f1b41`。
- 证据：2026-10-28，Issue 报告 Alpine 3.24 / armv7l 修复执行权限后仍报 `no such file or directory`。宿主平台来自 Go `GOOS-GOARCH`，值为 `linux-arm`；旧插件无该映射。上游 `2026.10.26` 只有 glibc ARMv7 目录包，没有 musl ARMv7 单文件。旧安装器还会吞掉版本执行错误，返回成功。
- 规则：平台架构与 libc 都要匹配；缺失动态加载器不能靠 chmod 修复。使用上游 PyInstaller 入口在 ARMv7 Alpine 中打包并内置 Python，在不安装 Python 的干净 musl 容器执行验证。安装/上传后必须执行 `--version` 成功；文件存在不能代替验收。
- 预发布选择：GitHub `releases/latest` 跳过预发布。定制二进制和插件放入同一个 Release，插件按自身版本读取 `releases/tags/v<version>`；手动下载回退保持同一标签。预发布不回写根稳定清单。
- Done right：Node 22.17.1 / Linux amd64，10 项回归、类型检查、QuickJS 插件打包、manifest 校验和 actionlint v1.7.12 通过。隔离旧 `binary.ts` 后同组测试失败 5 项，覆盖缺少 ARM 映射、错误下载回退及上传误报成功；日志 `/tmp/songloft-544-armv7/negative.log`。二进制运行证据以本次 CI 和 Release 的构建信息为准。
- Not run：玩客云真机、登录态站点/真实用户歌单和 YouTube JS 运行时；QEMU 与容器验证不替代这些验收。
- Seen 1× (2026-10-28)。
