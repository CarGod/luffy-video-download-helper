# Validation / 验证说明

Tested on macOS with a temporary Chromium profile. These checks describe specific tested behavior, not universal website compatibility.

## Automated checks

```sh
npm test
python3 -m unittest discover -s tests -p '*_test.py'
npm run build
```

The JavaScript suite covers media classification, filenames, HLS parsing and AES, media grouping, MCP page matching and operation selection. Python checks cover native command construction, format conversion and the Unix socket bridge.

## MCP end-to-end test

Install the native helper first, then run:

```sh
npx playwright install chromium
node scripts/mcp-integration.mjs
```

An alternate Chromium executable can be selected with `LUFFY_CHROMIUM`. The test uses a temporary browser profile and FFmpeg-generated media served on `127.0.0.1:18765`.

Verified behavior:

- Official MCP SDK client initialization and tool discovery.
- Active-page video discovery; rejection of stale page URLs.
- Actual MP4 and HLS downloads, checked with ffprobe.
- Cancellation of a slow HLS job.
- Enabling, disabling and restoring MCP settings; socket removal on disable.
- Copying Agent installation instructions and JSON; clipboard contents match the displayed configuration.
- The video tab is shown first; MCP controls live in their own tab.

Additional local browser checks are available in `scripts/integration.mjs` and `scripts/preview-integration.mjs`. They exercise direct files, ordinary / encrypted HLS, fMP4, separate audio, byte ranges and Referer-protected fixtures. Some older UI-specific scripts may need adjustment when the interface changes.

The optional `scripts/native-integration.mjs` and related platform checks access public external video samples and may download files into `~/Downloads/Luffy/`. They are not part of the offline/local fixture suite. Website changes can break these samples independently of local tests.

## Limits

- Windows / Linux native installation and an actual Edge installation have not been validated.
- No dedicated DASH acceptance sample, long-video stress test, or authenticated-cookie download test is included.
- DRM, SAMPLE-AES and live streams are unsupported.
- Browser HLS input is capped at 256 MiB. Native downloads require separately installed dependencies.

## Local artifacts and documentation screenshots

Generated logs, videos, paths and test screenshots live under ignored `artifacts/`; they are not published. Re-running tests creates fresh local results.

`node scripts/docs-screenshots.mjs` captures the actual UI using synthetic video in a temporary profile. The MCP status and configuration are explicit demonstration values, with a generic `your-name` path. Only those reviewed images under `docs/images/` are intended for publication.

中文：测试产物与真实本机路径不进入版本控制；文档截图使用合成媒体与示例 MCP 配置。上述通过项仅代表对应样例，不代表所有网站、登录状态或操作系统均已验收。
