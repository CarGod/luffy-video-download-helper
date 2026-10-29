# Validation / 验证说明

Tested on macOS with a temporary Chromium profile. These checks describe specific tested behavior, not universal website compatibility.

## Automated checks

```sh
npm test
python3 -m unittest discover -s tests -p '*_test.py'
npm run build
```

The JavaScript suite covers media classification, filenames, HLS parsing and AES, media grouping, MCP page matching and operation selection. Python checks cover native command construction, format conversion and the Unix socket bridge.

## Optional MCP output directory (local change)

The Python suite additionally covers the optional `output_directory` schema,
unchanged default/null calls, absolute paths and `~/`, missing directories,
permission failures, disk/copy failures, nonregular sources, source changes,
atomic collision handling across clients, interrupted publication, durable
pending records, source cleanup warnings, and malformed destination records.
Validation completed with 36 Python tests and the existing 18 JavaScript tests;
the extension build also passed.

Run the offline integration harness with a Python environment containing the
MCP SDK and with FFmpeg available:

```sh
python3 scripts/mcp-output-integration.py
```

It uses the real SDK over stdio, an isolated temporary Unix socket fixture, and
a one-second synthetic MP4. It checks the default saved path, an absolute Unicode
destination, preservation of an existing conflicting file, numbered publication,
SHA-256 byte equality, full video/audio decoding, and autonomous saving before
any `get_jobs` query. Reviewable evidence is saved under ignored
`artifacts/custom-output/`. This harness does not use a real browser connection,
download a public video, install files, or restart the native host. Browser/HLS/
native transport selection is unchanged; the new local save layer operates on
their completed job paths. End-to-end browser integration was not rerun for this
change. Unsupported hard-link filesystems are tested as explicit errors that
preserve the source; no network-share filesystem acceptance test was performed.

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
- Video downloads have no configured file-size cap; browser HLS still depends on available memory and processing capacity. Native downloads require separately installed dependencies.

## Local artifacts and documentation screenshots

Generated logs, videos, paths and test screenshots live under ignored `artifacts/`; they are not published. Re-running tests creates fresh local results.

`node scripts/docs-screenshots.mjs` captures the actual UI using synthetic video in a temporary profile. The MCP status and configuration are explicit demonstration values, with a generic `your-name` path. Only those reviewed images under `docs/images/` are intended for publication.

中文：测试产物与真实本机路径不进入版本控制；文档截图使用合成媒体与示例 MCP 配置。上述通过项仅代表对应样例，不代表所有网站、登录状态或操作系统均已验收。

## 0.4.5 resource lifecycle checks (2026-10-26)

The offline HLS resource tests cover unbounded media responses beyond the former
256 MiB threshold using virtual storage, exact response bytes, bounded playlist
and key responses, cancellation, save backpressure, early completion, failure
cleanup, and heartbeat recovery after lost release messages or background
restarts. An active browser save is never released merely because time elapsed.
The build checks and applies the pinned FFmpeg worker buffer-ownership patch.

The matching implementation was also exercised in the installed Ego browser:
two sequential downloads of a six-second synthetic fMP4 HLS video with separate
AAC audio and initialization segments completed. Each output was 517,969 bytes;
ffprobe reported H.264 320×180 plus AAC and a duration of 6.037 seconds. Full
decoding passed, MCP remained available, and no FFmpeg worker remained after
saving. These were local synthetic samples, not external website downloads.

No GB-scale memory-peak benchmark or long-video stress test was performed. HLS
merging still retains its inputs in browser memory rather than streaming them
through disk, so these changes do not establish an unlimited resource capacity.
