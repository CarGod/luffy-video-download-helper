# Third-party components

Luffy's application code is independently implemented. No DownloadHelper code, assets, branding, licence checks or proprietary package files are included.

- @ffmpeg/ffmpeg 0.12.15: MIT. https://github.com/ffmpegwasm/ffmpeg.wasm
- @ffmpeg/core 0.12.10: GPL-2.0-or-later per the published package. The WASM core includes FFmpeg and third-party codecs. Source and build recipes: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10 ; https://github.com/FFmpeg/FFmpeg . Review corresponding-source obligations before distributing binaries publicly.
- m3u8-parser 7.2.0 and @videojs/vhs-utils: Apache-2.0. https://github.com/videojs/m3u8-parser
- global / min-document / dom-walk bundled parser dependencies: MIT. https://github.com/Raynos/global ; https://github.com/Raynos/min-document ; https://github.com/Raynos/dom-walk
- esbuild: MIT (build-time only). https://github.com/evanw/esbuild
- yt-dlp and yt-dlp-ejs: installed separately by the native helper installer, not bundled into the extension. https://github.com/yt-dlp/yt-dlp and https://github.com/yt-dlp/ejs . See their notices for dependency licences.
- Native FFmpeg and Node.js are separately installed system tools, not bundled.

No runtime code is fetched from a CDN by the extension. The native helper installer downloads dependencies from PyPI; subsequent updates are explicitly run by the user.

- hls.js 1.7.3: Apache-2.0, bundled local HLS preview player. https://github.com/video-dev/hls.js

- MCP Python SDK 1.30.0: MIT, installed separately by the native installer. https://github.com/modelcontextprotocol/python-sdk
- Playwright: Apache-2.0, development/testing only. https://github.com/microsoft/playwright

The root MIT license applies to original project code. Third-party license texts under public/licenses retain their original terms. Generated dependency bundles, native environments and release archives are excluded from this source repository.
