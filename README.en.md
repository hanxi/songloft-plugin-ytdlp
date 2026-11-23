# yt-dlp Music Import

A Songloft JS plugin that uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to import playlists from YouTube, Bilibili, SoundCloud, and other supported sites.

## Features

- Import playlist metadata into your music library by pasting a URL.
- Import online tracks and resolve/cache audio URLs on first playback.
- Optionally download tracks for offline use.
- Support the 1000+ sites supported by yt-dlp.
- Deduplicate videos when importing.

## Installation

Install through Songloft plugin management, or download a `.jsplugin.zip` from [Releases](../../releases).

Add this plugin registry URL in Songloft Settings → JS Plugins → Plugin Sources:

```
https://raw.githubusercontent.com/hanxi/songloft-plugin-ytdlp/main/registry.json
```

## Usage

1. Install the matching yt-dlp binary in the plugin settings.
2. Paste a playlist or video URL on the import page.
3. Click Extract to load the track list.
4. Choose Import Only or Import and Download.

On Linux x86-64 and ARM64, automatic installation and the manual download link select an upstream binary based on the server's libc. If the settings page reports that yt-dlp cannot run, select **Reinstall yt-dlp** and check the error details below the status.

Automatic installation checks the downloaded file size and runs the new binary to verify its version before replacing the existing file. If the size check fails, try another GitHub proxy.

In Download Management, pause, resume, or cancel a batch. Cancellation stops queued tracks and retries. An in-flight track finishes before the batch stops, with Cancelling shown in the meantime. Downloaded files are retained. Clear the finished batch to start another.

### Smart speaker search source

The search test in Settings looks up a track and checks whether yt-dlp can resolve a direct audio URL. If the provider requires sign-in, the test prompts you to configure cookies. When smart speaker search results are imported, the speaker plugin can fetch track details first and let Songloft resolve the audio during playback. Direct playback without importing still requires a direct audio URL from the search source.

Callers that can import plugin-sourced tracks can send `X-Songloft-Resolve-Url: false` to `POST /api/search/topone`. The fast response includes `plugin_entry_path` and `source_data` and omits `url`. The plugin attempts full resolution when the search result lacks enough metadata to import. By default, the endpoint returns a direct audio URL.

### ARMv7 / Alpine

- ARMv7 (`armv7l`, reported by Songloft as `linux-arm`) uses `yt-dlp_musllinux_armv7l` from this plugin repository's matching Release. Python is bundled. The binary targets Alpine / musl; ARMv6 and glibc systems are not supported.
- Automatic installation and manual download links use the tag matching the installed plugin version, including prereleases. Other platforms continue to use official upstream yt-dlp releases.
- For a prerelease, manually install its `ytdlp.jsplugin.zip`, then install yt-dlp from the plugin settings once the ARM asset is ready. The normal registry continues to provide the stable version. Release notes show the asynchronous build status; the installer asks you to retry if the binary is not ready.
- The single-file executable requires an executable temporary directory. QEMU ARMv7 and clean Alpine container checks do not constitute validation on a physical OneCloud device. Sites such as YouTube may also require a JS runtime; Deno and browser impersonation dependencies are not bundled.

## Development

```bash
pnpm install
pnpm run dev         # Watch and upload to local Songloft
pnpm run build       # Produce dist/ytdlp.jsplugin.zip
pnpm run validate    # Validate plugin.json hashes
pnpm test            # Platform, prerelease download, and installation regressions
pnpm run typecheck
```

### Releases

Push to `main` to have `Release Plugin` package each pending code commit in mainline order. Documentation-only commits and generated version commits are skipped. After a failure, run the same workflow manually in GitHub Actions to resume from the unfinished commit. The workflow uses `RELEASE_BASE_SHA` as its initial activation boundary and then tracks which source was published in `plugin.json.releaseSource`.

Versions use Beijing time and the `YYYY.M.D.N` format. Each day starts at `.0`, and the sequence increases from the highest tag for the day, including prereleases. Tags carry a `v` prefix. If a legacy three-part tag exists on that date, start at `.1`. Allocated tags are retained. Manual runs can set the version for the next stable package or enable `prerelease` to package the current main branch as a preview.

There are two workflows:

1. `Release Plugin` installs locked dependencies in an isolated Git worktree, checks and tests the plugin, and builds the package. Each tag points to the corresponding source snapshot with its version metadata. The Release includes `ytdlp.jsplugin.zip`, the manifest from that ZIP, and `SHA256SUMS`. Stable releases then update the main-branch manifest.
2. `Build yt-dlp ARMv7` runs asynchronously using the tag and source commit recorded by the release workflow. When a push creates multiple Releases, each receives its own build. It resolves the latest stable upstream yt-dlp tag once and builds a `linux/arm/v7` single-file executable using a pinned Python Alpine image, upstream pinned Python dependencies, and the official PyInstaller entry point. A clean Alpine 3.24 container without Python, running as uid=1000, checks the version, extractors, real HTTP download, and HTTPS extraction. Passing assets are attached to the corresponding Release, and its ARM status is updated.

The ARM build does not block plugin publishing, and failures do not retract the plugin Release. To retry, manually run `Build yt-dlp ARMv7` with an existing Release tag. A successful build adds:

- `yt-dlp_musllinux_armv7l`
- `yt-dlp-SHA256SUMS`, `yt-dlp-build.json` (upstream version/commit, plugin commit, environment), the Python dependency list, and licenses

Prereleases do not update the root `plugin.json` / `package.json`, preserving the stable registry. Stable releases synchronize the built entry point, hashes, version, and download URL. Update the ARM binary through the plugin installer rather than yt-dlp's self-updater.

To reproduce locally, check out the required upstream release outside this repository:

```bash
docker buildx build --platform linux/arm/v7 \
  --build-arg YTDLP_VERSION=<upstream-version> \
  -f scripts/armv7/Dockerfile --output type=local,dest=/tmp/ytdlp-assets \
  /path/to/yt-dlp
node scripts/armv7/smoke.mjs /tmp/ytdlp-assets <upstream-version>
```

Docker ARM QEMU support is required and configured automatically in CI. Exact source and dependency versions are attached to each Release.

## Permissions

| Permission    | Purpose                                  |
| ------------- | ---------------------------------------- |
| `storage`     | Persist plugin settings                  |
| `command`     | Run yt-dlp and manage binaries           |
| `songs.write` | Download tracks through `songs.download` |

## License

Apache-2.0 © 2026 Songloft Team
