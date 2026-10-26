# Source and build information

Extension and native helper source for version 0.4.5 are in this Git checkout.
Repository and commit history:
https://github.com/CarGod/luffy-video-download-helper

Use the same Git commit when reproducing a build; version metadata alone does
not imply that a release tag or binary has been published.

Build the extension with Node.js 20+ using `npm ci && npm run build`.
`package-lock.json` records exact JavaScript dependency versions and integrity values.

The build applies a documented `canOwn` ownership patch to the pinned
@ffmpeg/ffmpeg JavaScript worker so MEMFS can reuse transferred input buffers.
The prebuilt @ffmpeg/core 0.12.10 WASM is used without modifications. Its upstream
source, Docker build recipes and dependency versions are available at:
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15
https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/Dockerfile

The matching upstream source archive is provided with the GitHub release as
`ffmpeg.wasm-v12.15-source.tar.gz`. Follow the Dockerfile and build scripts to
fetch and build its pinned FFmpeg/codec dependencies. These are upstream build
instructions; this project builds its own JavaScript wrapper and uses the
published WASM package, rather than rebuilding FFmpeg locally.

Third-party licenses are preserved in extension/licenses/ and
THIRD_PARTY_NOTICES.md. The native installer separately downloads yt-dlp and the
MCP Python SDK. System FFmpeg and Node.js are not bundled in the installer.
