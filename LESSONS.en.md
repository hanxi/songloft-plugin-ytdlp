# Development Lessons

Keep synchronized with [Chinese](LESSONS.md). Shared host rules are in the parent repository's `AGENTS.md`.

## ARM-001: ARMv7 binaries must match libc, and installation must be verified by execution

- Scope: binary selection, installation, and releases; songloft-org/songloft#544. Baseline `4ccac5d7aecce0ead2c3384afbefe8bb6c2f1b41`.
- Evidence: on 2026-10-28, the issue reported `no such file or directory` on Alpine 3.24 / armv7l even after executable permissions were fixed. The host reports Go `GOOS-GOARCH`, or `linux-arm`; the old plugin had no matching entry. Upstream `2026.10.26` provides a glibc ARMv7 directory archive, without a musl ARMv7 single-file executable. The old installer also swallowed version execution errors and reported success.
- Rule: match both architecture and libc; chmod cannot repair a missing dynamic loader. Bundle Python with the upstream PyInstaller entry point on ARMv7 Alpine, then execute in a clean musl container without Python. Installation and upload require a successful `--version`; file existence is insufficient.
- Prerelease selection: GitHub `releases/latest` excludes prereleases. Publish the custom binary and plugin in one Release, query `releases/tags/v<version>` using the installed plugin version, and keep the manual fallback on the same tag. Prereleases must not update the root stable manifests. As requested, a separate workflow appends ARM assets asynchronously without blocking plugin publishing, with an explicit not-ready message.
- Done right: Node 22.17.1 / Linux amd64; platform regressions, type checking, QuickJS packaging, manifest validation, and actionlint v1.7.12 passed. The initial ten tests failed five cases against an isolated copy of the old `binary.ts`, covering the missing ARM mapping, incorrect fallback, and false upload success. Log: `/tmp/songloft-544-armv7/negative.log`. Binary runtime evidence is recorded by the separate CI and Release build metadata; versioning and asynchronous status tests join the same checks.
- Not run: physical OneCloud hardware, authenticated sites or real user playlists, and a YouTube JS runtime. QEMU and container checks do not replace those checks.
- CI fixture: the first [independent build](https://github.com/hanxi/songloft-plugin-ytdlp/actions/runs/40628366392) produced an ARM ELF, musl interpreter, and correct version, but the uid=1000 check failed with `Permission denied` after export to the host. Normalize the exported directory and executable to 0755, matching installation's download + chmod behavior, while retaining the non-root and no-Python checks. Failed runtime checks preserve a diagnostic artifact without publishing it to the Release. Confirm the fix in the rerun.
- Seen 1× (2026-10-28).
