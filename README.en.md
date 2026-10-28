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

Manually run `Release Plugin` in GitHub Actions. An empty version follows MIOT's rules: Beijing time, `Y.M.D.N`, starting at `.0` each day and increasing numerically across all existing tags, including prereleases. If a legacy three-part tag exists on that date, start at `.1` to avoid an equal version. A future current-version date is preserved until the clock catches up, avoiding a downgrade. An explicit valid four-part version is also accepted. `prerelease` defaults to enabled; tags use `vY.M.D.N`. Existing Releases are never overwritten.

There are two workflows:

1. `Release Plugin` checks and builds the plugin, then immediately creates the Release with `ytdlp.jsplugin.zip`, its matching `plugin.json`, and plugin checksums in `SHA256SUMS`.
2. `Build yt-dlp ARMv7` starts asynchronously after the release workflow succeeds. A release context binds it to the exact tag and source commit. It resolves the latest stable upstream yt-dlp tag once and builds a `linux/arm/v7` single-file executable using a pinned Python Alpine image, upstream pinned Python dependencies, and the official PyInstaller entry point. A clean Alpine 3.24 container without Python, running as uid=1000, checks the version, extractors, real HTTP download, and HTTPS extraction. Passing assets are attached to the same Release, and its ARM status is updated.

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
