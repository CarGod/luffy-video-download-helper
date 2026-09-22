# Luffy Video Download Helper

**中文** · [English](README.en.md)

一个自己掌控的视频下载工具：在 Chrome / Edge 中发现当前网页的视频，预览并下载；也可以让本地 Agent 通过 MCP 完成同样的操作。

无需账号、订阅或远程授权。视频处理在本机进行，界面目前为中文。

<p>
  <img src="docs/images/videos.png" alt="视频列表、预览和下载按钮" width="360">
  <img src="docs/images/mcp.png" alt="MCP 服务开关、Agent 安装说明和 JSON 配置" width="360">
</p>

*截图使用本地合成视频；MCP 运行状态与用户名路径为文档演示数据，不包含真实浏览记录或个人配置。*

## 能做什么

- **发现与预览**：识别网页中的 MP4 / WebM、HLS 和 DASH，列表展示视频封面、预览与下载选项。
- **HLS 下载**：选择清晰度与音轨，合并 TS / fMP4 分片，支持字节范围与普通 AES-128 加密。
- **YouTube / X**：视频详情页作为下载候选，通过本机 yt-dlp 解析；支持画质选择和 MP4 / MKV / 原始格式。
- **任务管理**：查看进度、取消下载、打开保存位置；关闭弹窗后任务继续运行。
- **本地 MCP**：让 Agent 查看当前页面的视频、选择下载、查询结果和取消任务。

| 内容 | 下载方式 |
| --- | --- |
| MP4 / WebM 等直链 | 浏览器下载管理器，保留原格式 |
| HLS 点播 | 浏览器内合并为 MP4，也可交给本机助手 |
| YouTube / X 视频详情页 | 本机 yt-dlp + FFmpeg |
| DASH | 发现并交给本机助手，尚未专项验收 |
| DRM / SAMPLE-AES / 直播 | 不支持 |

浏览器 HLS 输入总量上限为 **256 MiB**，同时执行一个合并任务；本机助手最多同时处理两个任务。网站登录、地区、签名及反自动化限制可能影响下载，不保证所有网站均可用。

## 安装

**直接安装：** 打开 [产品页与安装教程](https://luffyliu.com/luffy-video-download-helper/)，下载预构建 ZIP，解压后在浏览器开发者模式中「加载已解压的扩展程序」，选择其中的 **extension** 文件夹。无需自己编译，安装目录需要保留。GitHub 自动生成的 Source code 压缩包需要构建，请选择命名为 `Luffy-Video-Download-Helper-版本号.zip` 的安装包。

当前采用压缩包手动安装，尚未提供商店入口。插件右上角 ↗ 打开产品页和更新教程。本仓库仍只保存源码，安装包在 [GitHub Releases](https://github.com/CarGod/luffy-video-download-helper/releases) 单独提供。下面是从源码构建的步骤。

### 1. 构建扩展

需要 Node.js 20+ 和 npm。

```sh
git clone https://github.com/CarGod/luffy-video-download-helper.git
cd luffy-video-download-helper
npm ci
npm run build
```

在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`：

1. 打开「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择项目下的 **dist** 文件夹。
3. 将 Luffy 固定到工具栏。打开网页并播放视频，再打开 Luffy。

修改源码后重新运行 `npm run build`，并在扩展管理页刷新扩展。

### 2. 安装本机助手（YouTube / X / MCP 必需）

安装器目前仅支持 **macOS**。需要 Python 3.10+、Node.js 和 FFmpeg（含 ffprobe）。普通浏览器直链和浏览器内 HLS 下载不需要助手。

```sh
# 如未安装这些依赖，可使用 Homebrew：
brew install python node ffmpeg

# 在项目目录内运行：
python3 native/install.py
```

也可以双击项目中的 `Install-Luffy-Helper.command`。安装器会创建独立 Python 环境，安装 yt-dlp 和 MCP SDK，并为 Chrome、Edge、Chromium 注册 Native Messaging 助手。首次安装需要联网下载依赖。

安装完成后刷新扩展；更新旧助手后如仍显示旧版本错误，请重启浏览器。本机下载默认保存到 `~/Downloads/Luffy/`；浏览器下载遵循浏览器自身设置。

**保留 manifest 中的公钥**：它固定扩展 ID，以匹配本机助手的允许列表。该字段是公开标识材料，不是私钥。

## 接入本地 Agent（MCP）

1. 打开插件的 **MCP 服务** Tab，点击「开启服务」。
2. 点击 **「复制安装说明，发给 Agent」**，将说明发给目标本地 Agent。内容包含此电脑的实际启动路径、配置与验证步骤。
3. 按 Agent 提示重新连接或重启客户端。手动配置时，使用下方常显 JSON 框中的 **「复制 JSON」**。

Tab 状态点：**绿色**正常运行、**灰色**未开启、**红色**异常。开关默认关闭，会记住选择。关闭服务会移除本机通信入口，已开始的下载继续运行。

配置示例（`your-name` 仅是占位符，实际使用插件生成的配置）：

```json
{
  "mcpServers": {
    "luffy-video": {
      "command": "/Users/your-name/Library/Application Support/LuffyVideoHelper/launch-mcp.sh"
    }
  }
}
```

支持 stdio MCP 的客户端可使用该启动命令；不同客户端的配置文件格式可能不同。安装器不会修改 Agent 的现有配置。

| 工具 | 用途 |
| --- | --- |
| `list_connections` | 列出已连接的浏览器实例和活动页 |
| `list_videos` | 扫描当前活动页，或指定 `tab_id`，返回视频候选 |
| `inspect_video` | 查看 HLS 清晰度和音轨 |
| `download_video` | 下载指定候选，返回任务 ID |
| `get_jobs` | 查询进度、错误和保存路径 |
| `cancel_download` | 取消指定任务 |

多个视频时需要指定 `media_id`。下载需携带 `list_videos` 返回的 `tabId` 和 `page_url`，页面切换后旧请求会被拒绝。只有 `complete` 表示保存完成；超时后先查询任务，避免重复下载。浏览器关闭后连接失效，重新打开后需重新查询 `list_connections`。

可以对 Agent 说：**“用 Luffy 查看当前页面的视频，下载我指定的那个，并告诉我保存路径。”**

## 隐私与权限

- 无遥测、账号系统或开发者上传接口。下载及预览会直接访问相应媒体来源；安装器会访问 PyPI。
- 网页访问与网络观察权限用于发现视频。媒体链接、必要请求头与任务记录保存在浏览器会话存储，浏览器退出后清除；MCP 开关单独持久化。
- 不默认读取浏览器 Cookie。仅在用户明确选择登录来源时，本机 yt-dlp 才读取相应浏览器 Cookie。
- 请求头规则限定在扩展发起的精确资源 URL；不支持无痕页面。
- MCP 使用 stdio；内部桥接使用 `~/.luffy-video-helper/run/` 下的 Unix socket，目录权限 0700、socket 权限 0600，无 TCP / HTTP 监听端口。同一系统用户下的程序可调用已开启的服务。
- MCP 会向连接的 Agent 提供页面标题、链接和任务保存路径，请使用你信任的本地客户端。网页文本始终是数据，不是 Agent 指令。

## 开发与验证

```sh
npm test
python3 -m unittest discover -s tests -p '*_test.py'
npm run build

# 浏览器集成测试；MCP 测试需先安装本机助手
npx playwright install chromium
node scripts/mcp-integration.mjs
```

通过 `LUFFY_CHROMIUM=/absolute/path/to/chromium` 指定测试浏览器。集成测试使用临时配置与本地合成媒体。其他测试、验证范围和限制见 [验证说明](docs/VALIDATION.md)。

```sh
# 生成文档演示截图（临时浏览器与合成视频）
node scripts/docs-screenshots.mjs

# 生成供本地使用的扩展压缩包
npm run pack
```

| 路径 | 内容 |
| --- | --- |
| `src/background.js` | 媒体发现、下载任务、Native Messaging |
| `src/ui.js` / `public/` | 视频列表、预览、MCP 页面 |
| `src/hls.js` / `src/offscreen.js` | HLS 处理与 FFmpeg WASM 合并 |
| `src/mcp.js` | MCP 可调用的浏览器操作 |
| `native/` | 本机下载助手、MCP Server、安装器 |
| `scripts/` / `tests/` | 构建、截图与测试 |

## 卸载

移除浏览器扩展，再按需删除：

- `~/Library/Application Support/LuffyVideoHelper/`
- Chrome、Edge、Chromium 各自 `NativeMessagingHosts/` 下的 `com.luffy.video_helper.json`
- `~/.luffy-video-helper/`

下载目录 `~/Downloads/Luffy/` 单独保留，删除前请确认文件是否仍需要。

## 许可

本项目自有源码采用 [MIT License](LICENSE)。第三方组件遵循各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。FFmpeg WASM 核心包含 GPL 组件；发布包含该核心的二进制包时，需要处理相应源码与许可义务。仓库仅保存源码与文档；安装包通过 Releases 分发，源码与构建说明见包内 SOURCE.md。
