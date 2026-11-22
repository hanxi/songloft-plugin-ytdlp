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

## BATCH-001：取消必须唤醒等待并保留当前调用的真实结果

- 范围：下载批次，songloft-org/songloft#544；基线 `10717798e8131c144ae10315f6b709bd635df982`。
- 证据：2026-11-02，用户报告只能暂停不能取消；原清除逻辑丢弃暂停回调，且异步循环读取全局任务，新批次可能被旧回调写入。
- 规则：每批次独立持有状态；取消唤醒暂停、下载间隔和重试等待；当前宿主单首调用结束前不释放运行槽位，不宣称立即中断。
- Done right：新增回归旧代码失败 9 项；最终全套 31 项通过，类型检查、QuickJS 构建及校验通过。Docker Chrome 操作真实隔离宿主，验证运行中取消、自动暂停后取消、清除与新批次；SQLite 确认当前歌曲落地、队列歌曲仍 remote。证据 `/tmp/songloft-544-cancel/`。初版音频夹具仅 4 秒，触发现有 30 秒校验下限；最终使用 40 秒自生成音频及受控解析器。
- Not run：玩客云真机、ARMv7 本轮运行、真实第三方站点；尚未提交、推送或发布。
- Seen 1× (2026-11-02)。

## BIN-001：Linux 二进制选择须检查宿主 libc

- 范围：Linux x86-64 / ARM64 的 yt-dlp 安装与诊断。[hanxi/songloft-plugin-ytdlp#9](https://github.com/hanxi/songloft-plugin-ytdlp/issues/9)，插件基线 `85687d23e90a34784bdcca4012cda1d1135f5eea`。
- 证据：正式版 `v2026.10.28.0` 在 Debian 12 x86-64 上对已落盘的上游 musl 包报 `fork/exec … no such file or directory`，设置页同时报告「已安装」且无版本。ELF 指定的 `/lib/ld-musl-x86_64.so.1` 在该宿主不存在；Alpine 3.24.1 上执行 glibc 包也复现缺失加载器。报告人的设备和文件来源仍待确认。
- 正确示例：在 Songloft 服务端通过 `getconf GNU_LIBC_VERSION` 识别 glibc，自动安装与手动下载链接共用资产选择。设置页按 `--version` 是否成功显示可用状态，宿主报告缺失的 ELF 加载器时显示具体路径。
- 验证：旧源码未通过 7 项回归，修复后 40 项测试、类型检查、QuickJS 构建和校验通过。Docker Chrome 在真实本地 Songloft 宿主点击「重新安装 yt-dlp」，用本地代理夹具提供经 SHA-256 校验的上游 glibc 包，回读版本 `2026.10.26` 与落盘哈希。Alpine 非 root 执行上游 musl 包同样返回该版本。B 站「单车」联机搜索曾返回 HTTP 412，复测返回 5 条结果，均导入临时歌单并核对入库。
- 同日后续：报告人确认手动替换 `yt-dlp_musllinux_aarch64` 后可搜索。基线 `5e1ba63f5ac91511570bee30dccc318d605a1bad` 首次读取宿主平台失败会缓存 x86-64，且自动安装会在验证前覆盖现有文件。修复后按需重查平台；自动下载比对 Release 字节数，并执行临时文件的 `--version`，成功后才替换。真实 Songloft 宿主通过本地代理夹具复现旧版覆盖为 10 MB 短文件，新版保留原文件，应对短响应、中断和重试。该复现仍无法确定报告人当时收到的文件内容。
- 后续验证：Linux x86-64 / Node 22.17.1，隔离旧实现未通过 7 项回归。修复后 46 项测试、类型检查、QuickJS 打包及校验通过。真实 Songloft 宿主集成测试使用与正式附件大小相同的可执行夹具。上游 ARM64 musl 附件 SHA-256 一致；QEMU 用户态无法重新执行 ARM64 子进程，ARM64 安装仍待真机验证。
- Seen 1× (2026-11-22)。

## RELEASE-001：逐提交发布须分别交接 ARMv7 构建

- 范围：自动发布启用前的 yt-dlp 基线 `55fce95241c387f416e5902c4bb8f078e11ba311`。旧流程只提供一个 Release 上下文；一次推送可发布多个包后，逐项记录标签和源码提交，并在后续提交失败时保留已发布条目。
- 验证：本地模拟批量推送、后续构建失败及主线写入失败。已发布包仍交接 ARMv7，重跑接回原 Release。ARM 解析核对 tag 对应的快照与其原始源码。用真实冻结依赖打包，在临时 Git 远端验证标签、ZIP 清单、SHA-256、主线和交接内容；未运行真实 GitHub 发布或 ARM 构建。
- Seen 1× (2026-11-22)。
