# 开发经验

与 [英文版](LESSONS.en.md) 同步；公共宿主规则见主仓库的 `AGENTS.md`。

## ARM-001：ARMv7 产物必须匹配 libc，安装成功必须以实际执行为准

- 范围：本插件二进制选择、安装与发布；songloft-org/songloft#544。基线 `4ccac5d7aecce0ead2c3384afbefe8bb6c2f1b41`。
- 证据：2026-10-28，Issue 报告 Alpine 3.24 / armv7l 修复执行权限后仍报 `no such file or directory`。宿主平台来自 Go `GOOS-GOARCH`，值为 `linux-arm`；旧插件无该映射。上游 `2026.10.26` 只有 glibc ARMv7 目录包，没有 musl ARMv7 单文件。旧安装器还会吞掉版本执行错误，返回成功。
- 规则：平台架构与 libc 都要匹配；缺失动态加载器不能靠 chmod 修复。使用上游 PyInstaller 入口在 ARMv7 Alpine 中打包并内置 Python，在不安装 Python 的干净 musl 容器执行验证。安装/上传后必须执行 `--version` 成功；文件存在不能代替验收。
- 预发布选择：GitHub `releases/latest` 跳过预发布。定制二进制和插件放入同一个 Release，插件按自身版本读取 `releases/tags/v<version>`；手动下载回退保持同一标签。预发布不回写根稳定清单。按用户要求，ARM 构建由独立 workflow 异步追加附件，不阻塞插件发布；构建未完成时明确提示。
- Done right：Node 22.17.1 / Linux amd64，平台回归、类型检查、QuickJS 插件打包、manifest 校验和 actionlint v1.7.12 通过。隔离旧 `binary.ts` 后初始 10 项测试失败 5 项，覆盖缺少 ARM 映射、错误下载回退及上传误报成功；日志 `/tmp/songloft-544-armv7/negative.log`。二进制运行证据以本次独立 CI 和 Release 的构建信息为准；后续版本规则、异步状态测试纳入同一套检查。
- Not run：玩客云真机、登录态站点/真实用户歌单和 YouTube JS 运行时；QEMU 与容器验证不替代这些验收。
- CI 验证夹具：首次[独立构建](https://github.com/hanxi/songloft-plugin-ytdlp/actions/runs/40628366392)成功生成 ARM ELF、musl 加载器和正确版本，但导出到宿主后 uid=1000 的验证报 `Permission denied`。[修复重跑](https://github.com/hanxi/songloft-plugin-ytdlp/actions/runs/40630315530)确认导出目录为 0700、二进制为 0755；准备夹具时将两者设为 0755，继续保留非 root 和无 Python 条件。工作流代码 `5c4edf5cc2b356f6c8509afba3b24c708faa283a` 在 QEMU ARMv7 / Alpine 3.24 / uid=1000 下通过版本（2.40 秒）、提取器、真实 HTTP 下载及 HTTPS 解析，附件成功追加到 `v2026.10.28.0`。运行检查失败时只保存诊断 artifact，不上传 Release。
- 发布验收：18 项测试及四段版本打包演练通过；发布包和全部 ARM 附件 SHA-256 复核通过。实际安装包在独立 Go 宿主的真实 QuickJS/command 桥中完成下载、chmod、执行和状态回读，落盘哈希一致。环境为 ARMv7 Alpine 用户态 + QEMU、静态 amd64 Go 宿主，并在临时数据库覆盖 `server_platform=linux-arm`；本机 GitHub 直连触发现有宿主 120 秒下载超时，因此成功安装使用现有 GitHub 代理设置及提供同一已校验文件的本地代理夹具。该结果不冒充 ARM Go 宿主、直连网络或真机验收。证据 `/tmp/songloft-544-armv7/integration-{initial,pending,ready}.json`、`retry-ci.log` 和 `published/`。
- Seen 1× (2026-10-28)。
