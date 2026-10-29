#!/usr/bin/env python3
"""Install the local host for this fixed extension ID (macOS)."""
import base64, hashlib, json, os, shutil, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
HOME=Path.home()
if sys.platform!='darwin':
    raise SystemExit('此安装器目前支持 macOS。')
if not shutil.which('ffmpeg'):
    raise SystemExit('缺少 FFmpeg。请先运行 brew install ffmpeg')
TARGET=HOME/'Library/Application Support/LuffyVideoHelper'
TARGET.mkdir(parents=True,exist_ok=True)
ENV=TARGET/'venv'
if not (ENV/'bin/python').exists():
    subprocess.run([sys.executable,'-m','venv',str(ENV)],check=True)
subprocess.run([str(ENV/'bin/python'),'-m','pip','install','--upgrade','yt-dlp[default]', 'mcp==1.30.0'],check=True)
for name in ['host.py', 'bridge.py', 'mcp_server.py', 'output_directory.py']:
    shutil.copy2(ROOT/'native'/name, TARGET/name)
node=shutil.which('node')
if not node:
    raise SystemExit('缺少 Node.js（用于 YouTube 签名解析），请先安装 Node.js。')
import shlex
wrapper=TARGET/'launch.sh'
wrapper.write_text('#!/bin/sh\nexport PATH='+shlex.quote(str(Path(node).parent)+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')+'\nexec '+shlex.quote(str(ENV/'bin/python'))+' '+shlex.quote(str(TARGET/'host.py'))+'\n')
wrapper.chmod(0o700)
manifest_path=ROOT/'public/manifest.json'
if not manifest_path.exists():manifest_path=ROOT/'extension/manifest.json'
key=json.loads(manifest_path.read_text())['key']
hexid=hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
extid=''.join(chr(ord('a')+int(c,16)) for c in hexid)
manifest={'name':'com.luffy.video_helper','description':'Luffy local video downloader','path':str(wrapper),'type':'stdio','allowed_origins':['chrome-extension://'+extid+'/']}
for browser in ['Google/Chrome','Microsoft Edge','Chromium']:
    directory=HOME/'Library/Application Support'/browser/'NativeMessagingHosts'
    directory.mkdir(parents=True,exist_ok=True)
    path=directory/'com.luffy.video_helper.json'
    path.write_text(json.dumps(manifest,indent=2));path.chmod(0o600)
print('\nLuffy 本机助手安装完成。扩展 ID: '+extid+'\n下载目录: '+str(HOME/'Downloads/Luffy'))

mcp_wrapper=TARGET/'launch-mcp.sh'
mcp_wrapper.write_text('#!/bin/sh\nexec '+shlex.quote(str(ENV/'bin/python'))+' '+shlex.quote(str(TARGET/'mcp_server.py'))+'\n')
mcp_wrapper.chmod(0o700)
config={'mcpServers': {'luffy-video': {'command': str(mcp_wrapper)}}}
(TARGET/'mcp-config.json').write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
print('MCP 配置: '+str(TARGET/'mcp-config.json'))
