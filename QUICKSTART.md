# PenguX11VNC：5 分钟配置

目标：在另一台设备打开 **Linux 上已经运行的 QQ 窗口**。不会启动第二个 QQ。

## 1. 安装

### macOS

```sh
cd qq-viewer
npm ci
```

Tauri 入口需要：Node.js 22+、Rust/Cargo、能执行 `ssh` 的终端。Python 3 和 Chrome 仅是旧回退启动器的依赖。

### Linux / Windows

当前网页前端可以运行在 Chromium/Chrome 中；Tauri 2 版本也已可运行。Rust 管理 SSH/VNC/子窗口生命周期，Node 暂时只提供本地 HTTP/WebSocket bridge。

## 2. 远端准备

Linux 上必须已经有：

- QQ 登录并显示在本地屏幕；
- `x11vnc` 只监听 `127.0.0.1:5900`；
- SSH 服务；
- VNC 密码文件；
- 本工具的两个可选 helper：`capture-ime`、`list-qq-windows`。

远端窗口信息先查出来：

```sh
echo "$DISPLAY"
echo "$XAUTHORITY"
xprop -root _NET_CLIENT_LIST_STACKING
```

不要把 VNC 端口直接暴露到局域网或公网。

## 3. SSH 登录

先确认无交互登录成功：

```sh
ssh -o BatchMode=yes user@linux-host true
```

有私钥时：

```sh
python3 tools/import-key.py ~/.ssh/id_ed25519
```

把脚本输出的路径写入配置档的 `ssh.privateKeyFile`。加密私钥先加入 agent：

```sh
ssh-add ~/.config/qq-window-viewer/keys/id_remote
```

Windows 使用 OpenSSH 的 `ssh-agent`；Linux/macOS 使用系统 `ssh-agent` 或钥匙串。工具不保存私钥口令。

## 4. 创建连接配置

```sh
mkdir -p ~/.config/qq-window-viewer
cp connections.example.json ~/.config/qq-window-viewer/connections.json
chmod 600 ~/.config/qq-window-viewer/connections.json
```

编辑以下字段：

| 字段                                   | 含义                                            |
| -------------------------------------- | ----------------------------------------------- |
| `ssh.user` / `ssh.host` / `ssh.port`   | SSH 登录信息                                    |
| `ssh.privateKeyFile`                   | 本机私钥路径；留空表示使用 agent/默认密钥       |
| `tunnel.localPort`                     | 本机端口，通常 `15900`                          |
| `tunnel.remoteHost` / `remotePort`     | 远端 x11vnc 地址，通常 `127.0.0.1:5900`         |
| `vnc.passwordFile`                     | 本机 VNC 密码文件；没有则弹窗输入               |
| `vnc.remotePasswordFile`               | Linux 上 x11vnc 使用的密码文件                  |
| `window.display` / `xauthority` / `id` | Linux Xwayland 会话信息                         |
| `helpers.windowList` / `imeCapture`    | 远端 helper 的绝对路径                          |
| `clipboard.sync`                       | 是否允许此配置档启用剪贴板同步，默认 `false`    |
| `viewer.bitrate`                       | `lossless`、`high`、`balanced`、`low`；默认无损 |
| `viewer.frameRate`                     | `0` 不限，或 `5/10/15/24/30/60`；默认 `30`      |
| `viewer.uiCollapsed`                   | 是否启动时收起 UI；收起后仍保留底部状态栏       |

主窗口运行时修改的显示设置会保存到 `~/.config/qq-window-viewer/settings.json`；QQ 子窗口继承主窗口设置。

密码文件权限必须是 `600`。JSON 不支持注释；需要说明时另写文档，不要把密码写进 JSON。

## 5. 启动

macOS 双击：

```text
启动 PenguX11VNC.command
```

旧的 `启动 QQ 窗口.command` 仍然可用。

Tauri 开发版：

```sh
npm run tauri:dev
```

命令行选择配置档：

```sh
python3 tools/launch.py --config ~/.config/qq-window-viewer/connections.json --profile linux-qq
```

只启动本地服务、不打开 Chrome：

```sh
python3 tools/launch.py --no-open
```

打开后：

1. 点「连接窗口」；
2. 「适应」保持比例，「1:1」查看原始像素；
3. 设置中调滚轮、传输码率和帧率；
4. 需要时开启双向剪贴板同步；
5. 「收起」隐藏四周 UI，但保留底部状态栏；鼠标移到顶部边缘可暂时展开，悬浮球可拖动并恢复。

## 6. 常见问题

### 黑屏或无法连接

```sh
ssh -o BatchMode=yes user@linux-host true
nc -vz 127.0.0.1 15900
```

确认远端 `x11vnc` 还在运行，并且 SSH 转发的是 `127.0.0.1:5900`。

### 鼠标偏移

远端 x11vnc 必须保留：

```text
-xwarppointer
```

不要使用 `x11vnc -scale`；让前端缩放。

### 候选框不见

主画面只捕获 QQ。候选框需要 `capture-ime`，而且 QQ 必须获得焦点。原生 Wayland popup、注销后变化的 XAUTHORITY 或 QQ XID 需要重新配置。

### 子窗口

配置 `children.enabled=true` 后，前端递归检查 X11 窗口树，只接受可见、同属 QQ 类名且达到最小尺寸的窗口；`QQ`/`Qq` 类名均兼容。每个子窗口单独启动 localhost VNC 和 SSH 转发，并打开新的前端窗口，子窗口页面会自动连接。Linux 子窗口关闭后，前端会自动关闭对应浏览器窗口并清理会话。未映射的隐藏窗口不会捕获；没有匹配窗口时不会启动额外服务。

## 7. 安全边界

- 本地 Web/WS 只监听 `127.0.0.1`；
- VNC 只通过 SSH 转发；
- 本机密码文件只读进程内存，不保存到浏览器；
- 默认不读写剪贴板；
- 不上传私钥、不上传配置、不经过云端；
- `.runtime/` 是私有运行数据，不要提交或分享。

## 8. 开源与跨平台状态

当前可复用部分：noVNC core（MPL-2.0）、本地 Web/WS bridge、JSON 配置、滚轮限速和窗口会话逻辑。

Tauri 2 当前已完成第一阶段外壳；后续仍需迁移 bridge：

- macOS：原生窗口、文件选择器、SSH/私钥导入；
- Windows：OpenSSH/agent、文件选择器、原生窗口；
- Linux：X11/Wayland、系统密钥环；
- Android 平板：横屏布局、触摸/虚拟滚轮、系统剪贴板权限、SSH 私钥导入。

Android 不应直接复用桌面启动器；它需要独立的 SSH/存储权限适配。详见 `TODO.md`。
