# PenguX11VNC：首次连接与远端准备

目标：在另一台设备打开 **Linux 上已经运行的 QQ 窗口**。不会启动第二个 QQ。

## 1. 安装

### macOS

下载 GitHub Actions 的调试 `.dmg` 后直接安装即可；安装包已内置对应架构 Node.js。源码开发时执行：

```sh
cd qq-viewer
npm ci
```

源码 Tauri 入口需要：Node.js 22+、Rust/Cargo、能执行 `ssh` 的终端。Python 3 和 Chrome 仅是旧回退启动器的依赖；系统仍需 OpenSSH。

### Linux / Windows

优先下载对应 GitHub Actions 调试产物：Linux 为 `.AppImage`，Windows 为 NSIS 安装包；amd64/arm64 分开构建，安装包已内置对应架构 Node.js。系统仍需 OpenSSH，远端依赖按下方说明准备。

源码主要在 macOS 验证 Tauri 与 Chrome 回退入口。Linux / Windows 仍需平台编译依赖、路径及 SSH agent 回归；不要将现有源码视为这些平台已经验证的安装包。Rust 管理 SSH/VNC/子窗口生命周期，Node 暂时提供本地 HTTP/WebSocket bridge。

## 2. 推荐：软件内连接向导（Tauri）

运行 `npm run tauri:dev`，没有配置时自动打开向导。已有配置点击首页「首次连接 / 更换设备」或设置中的「配置向导与故障引导」。

- 填写 SSH 信息后点击「运行只读预检」，不再要求手工填写 DISPLAY、XAUTHORITY 或主窗口 XID。
- 只有一个合法的主窗口候选时自动选中；多个候选必须选择。无可见窗口会提供原因和处理提示。
- 根据内置引导处理缺少依赖、主机指纹、密钥 agent 或密码文件问题，然后重新预检。
- 勾选 localhost 单窗口 VNC 授权、按需开启自动恢复，保存后返回首页点击连接。
- 保存只写本机配置（权限 600）并先备份旧文件；不会自动安装包、启动或登录 QQ。
- 主动断开停止自动恢复并回收本次自建服务。现有 VNC 和共享 SSH 隧道不会被停止。

远端仍需准备一次。下面手工配置章节供旧 Chrome/Python 入口及高级用户使用；Tauri 向导用户不需要复制示例 JSON。

## 3. 远端准备

Linux 上必须已经有：

- QQ 登录并显示在本地屏幕；
- Python 3、libX11 和 `x11vnc` 已安装；向导模式会启动仅 localhost 的独立 VNC，手工模式需自行准备 VNC；
- SSH 服务；
- VNC 密码文件；
- 本工具的两个可选 helper：`capture-ime`、`list-qq-windows`。

手工模式才需要查询窗口信息（SSH shell 的空环境不能代表 QQ 会话）：

```sh
echo "$DISPLAY"
echo "$XAUTHORITY"
xprop -root _NET_CLIENT_LIST_STACKING
```

不要把 VNC 端口直接暴露到局域网或公网。

## 4. SSH 登录

先确认无交互登录成功：

```sh
ssh -o BatchMode=yes user@linux-host true
```

有私钥时：

```sh
python3 tools/import-key.py ~/.ssh/id_ed25519
```

把脚本输出的路径写入配置档或向导中的私钥路径。加密私钥先加入 agent：

```sh
ssh-add ~/.config/qq-window-viewer/keys/id_remote
```

Windows 使用 OpenSSH 的 `ssh-agent`；Linux/macOS 使用系统 `ssh-agent` 或钥匙串。工具不保存私钥口令。

## 5. 手工创建连接配置（可选）

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

## 6. 启动

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

## 7. 常见问题

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

## 8. 安全边界

- 本地 Web/WS 只监听 `127.0.0.1`；
- VNC 只通过 SSH 转发；
- 本机密码文件只读进程内存，不保存到浏览器；
- 默认不读写剪贴板；
- 不上传私钥、不上传配置、不经过云端；
- Tauri 应用数据目录和旧回退入口的 `.runtime/` 都是私有运行数据，不要提交或分享。

## 9. 开源与跨平台状态

当前可复用部分：noVNC core（MPL-2.0）、本地 Web/WS bridge、JSON 配置、滚轮限速和窗口会话逻辑。

Tauri 2 当前已完成第一阶段外壳；后续仍需迁移 bridge：

- macOS：原生窗口、文件选择器、SSH/私钥导入；
- Windows：OpenSSH/agent、文件选择器、原生窗口；
- Linux：X11/Wayland、系统密钥环；
- Android 平板：横屏布局、触摸/虚拟滚轮、系统剪贴板权限、SSH 私钥导入。

Android 不应直接复用桌面启动器；它需要独立的 SSH/存储权限适配。详见 `TODO.md`。
