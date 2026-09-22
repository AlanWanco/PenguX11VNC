# PenguX11VNC：首次连接与远端准备

目标：在另一台设备打开 **Linux 上已经运行的 QQ 窗口**。不会启动第二个 QQ。

## 1. 安装

### macOS

下载 GitHub Actions 的调试 `.dmg` 后直接安装即可；安装包已内置对应架构 Node.js。源码开发时执行：

```sh
cd PenguX11VNC
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
- Tauri 主窗口连接后会由原生窗口事件锁定 VNC 画面加 UI 外框的长宽比；拖动任意窗口边缘时另一条边自动跟随。浏览器回退入口无法获得同样的原生边框约束。

### 发送剪贴板文件

在 Tauri 设置中点击「上传剪贴板文件到远端 Downloads」后，应用读取本机文件剪贴板并显示确认信息。单次文件合计上限 50 MiB，仅传送普通文件，不递归传送文件夹。确认后按现有 SSH 私钥配置执行 SCP：文件进入远端 `xdg-user-dir DOWNLOAD` 指向的目录（通常是 `~/Downloads`），并将远端路径写入 Linux `text/uri-list` 剪贴板。回到 QQ 窗口手动按 `Ctrl+V`，不会自动发送消息。

远端针对 X11/XWayland QQ 先尝试 `xclip` 写入 `text/uri-list`，若 `python3` 可用还会启动内置 X11 剪贴板 owner，补充 GNOME/KDE 的多 MIME 文件格式；`xclip` 不可用时再尝试 `wl-copy`，最后使用该 Python/X11 写入器。若 QQ/桌面未接受文件剪贴板格式，界面会报告失败或仍需使用远端文件管理器。Chrome 回退入口不读取本机文件剪贴板。

### 隐藏、恢复和退出

Tauri 默认点击主窗口关闭按钮时，只隐藏到 **Windows/Linux 系统托盘**或 **macOS 菜单栏**，连接继续保持。使用图标菜单「显示主窗口」恢复；Windows 也支持左键点击图标，macOS 也可点击 Dock 图标。选择「退出 PenguX11VNC」（macOS 也支持 `Cmd+Q`）才停止本地后台和清理本次会话，不退出远端 QQ 主程序。QQ 子窗口关闭行为不变。

图标为透明背景黑/白单色，随系统浅/深色切换：macOS 使用系统模板着色；Windows 跟随任务栏主题；Linux 跟随 KDE/GTK 配色。Linux 需要 StatusNotifier/AppIndicator 托盘宿主（KDE 自带，GNOME 通常需要扩展）；没有可用宿主时主窗口使用普通关闭行为，不会隐藏后失联。独立自定义面板配色可能与桌面主题不同。普通最小化按钮仍保持系统原有行为。

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
ssh-add ~/.config/pengux11vnc/keys/id_remote
```

Windows 使用 OpenSSH 的 `ssh-agent`；Linux/macOS 使用系统 `ssh-agent` 或钥匙串。工具不保存私钥口令。

## 5. 手工创建连接配置（可选）

```sh
mkdir -p ~/.config/pengux11vnc
cp connections.example.json ~/.config/pengux11vnc/connections.json
chmod 600 ~/.config/pengux11vnc/connections.json
```

编辑以下字段：

| 字段                                   | 含义                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ssh.user` / `ssh.host` / `ssh.port`   | SSH 登录信息                                                                                                          |
| `ssh.privateKeyFile`                   | 本机私钥路径；留空表示使用 agent/默认密钥                                                                             |
| `tunnel.localPort`                     | 本机端口，通常 `15900`                                                                                                |
| `tunnel.remoteHost` / `remotePort`     | 远端 x11vnc 地址，通常 `127.0.0.1:5900`                                                                               |
| `vnc.passwordFile`                     | 本机 VNC 密码文件；没有则弹窗输入                                                                                     |
| `vnc.remotePasswordFile`               | Linux 上 x11vnc 使用的密码文件；向导留空会自动检查 `$XDG_RUNTIME_DIR/x11vnc.pass` 与 `~/.config/pengux11vnc/vnc.pass` |
| `window.display` / `xauthority` / `id` | Linux Xwayland 会话信息                                                                                               |
| `helpers.windowList` / `imeCapture`    | 远端 helper 的绝对路径                                                                                                |
| `clipboard.sync`                       | 是否允许此配置档启用剪贴板同步，默认 `false`                                                                          |
| `viewer.bitrate`                       | `lossless`、`high`、`balanced`、`low`；默认无损                                                                       |
| `viewer.frameRate`                     | `0` 不限，或 `5/10/15/24/30/60`；默认 `30`                                                                            |
| `viewer.connectionMode`                | `vnc` 或 `video`；仅在主页连接前选择，默认 `vnc`                                                                      |
| `video.codec`                          | 当前为 `vp8`                                                                                                          |
| `video.fps`                            | `30` 或 `60`；默认 `60`                                                                                               |
| `video.bitrateKbps`                    | 软件编码目标码率；默认 `4000`                                                                                         |
| `video.udpPortStart` / `udpPortEnd`    | 远端 WebRTC UDP 端口范围；默认 `40000-40100`                                                                          |

主窗口运行时修改的显示设置会保存到 `~/.config/pengux11vnc/settings.json`；QQ 子窗口继承主窗口设置。

### 实验性 WebRTC 视频流

在主页连接前选择「实验性视频流」后，RFB 只负责键盘、鼠标和剪贴板，远端按 QQ X11 窗口 XID 启动临时 GStreamer/VP8/WebRTC 进程，前端用 UDP 接收唯一画面。状态栏会显示当前实际方式。视频失败时不会自动回退到 VNC，而是断开本次连接并回到主页重新选择。当前不捕获整个桌面，也不会创建第二个 QQ。

远端需要额外具备 `gstreamer`、`gst-plugins-base`、`gst-plugins-good`、`gst-plugins-bad` 和 GStreamer 的 Python GI 绑定；未来 H.264 实验才需要额外的 `gst-plugins-ugly`/x264。应用不会自动安装。需要在远端防火墙放行配置的 UDP 端口范围，建议仅允许本机客户端 IP。未放行、WebRTC 协商失败或编码器不可用时，本次视频连接会断开，不会自动切换到 VNC；普通 VNC 连接不受影响。

当前实验只启用 VP8/60 FPS，并通过 SSH 传递信令；视频进程随会话启动和退出，不是远端常驻服务。

Tauri 主窗口支持拖放文件：连接后将一个或多个普通文件拖到窗口，松开并确认后会通过现有 SSH/SCP 流程上传到远端 Downloads，再在 QQ 中手动按 `Ctrl+V`。目录、重复文件和单次合计超过 50 MiB 的内容会被拒绝。

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
python3 tools/launch.py --config ~/.config/pengux11vnc/connections.json --profile linux-qq
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
5. 关闭 Tauri 系统标题栏后，可点击顶部右侧按钮展开细工具栏；关闭按钮固定在顶部栏最右侧。

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

配置 `children.enabled=true` 后，前端递归检查 X11 窗口树，只接受可见、同属 QQ 类名且达到最小尺寸的窗口；`QQ`/`Qq` 类名均兼容。每个子窗口单独启动 localhost VNC 和 SSH 转发，并打开新的前端窗口，子窗口页面会自动连接。关闭本地子窗口或点击子窗口「断开」时，会立即回收 VNC 会话并请求关闭对应的 Linux QQ 子窗口。未映射的隐藏窗口不会捕获；没有匹配窗口时不会启动额外服务。

在主连接保持运行时，Linux QQ 子窗口关闭后，对应的 Tauri 子窗口也会自动关闭；关闭「自动打开子窗口」不会停止对已打开窗口的回收。本地 QQ 子窗口标题栏关闭使用 Tauri 原生默认行为，远端清理在后台执行，不等待 SSH 才关闭窗口；主窗口关闭则默认隐藏到托盘/菜单栏。Tauri 主窗口和 QQ 子窗口会按主窗口的 VNC 缩放倍率统一适配当前屏幕并保持比例，播放区铺满且保留底部状态栏；「系统标题栏」可在设置中开关。关闭后顶部默认显示细深紫色工具条，点击右侧按钮可展开控制按钮。

开发时注意：`core:default` 不包含窗口 `close`/`destroy` 权限。当前仅额外授予 `core:window:allow-close`，用于主窗口关闭对应子窗口；不要添加仅做清理的 `onCloseRequested` 监听，它会拦截默认关闭并使 Tauri JS 依赖 `destroy` 权限。异步关闭失败必须保留窗口记录，不能把「请求关闭」当作「窗口已销毁」。

### 收集子窗口、鼠标和 VNC 恢复日志

需要复现问题时，启动前临时设置 `PENGUX11VNC_DEBUG=1`：

```sh
PENGUX11VNC_DEBUG=1 npm run tauri:dev
```

该开关会记录窗口枚举、远端 SSH 标准错误、子窗口会话清理、VNC 断线/重连、缩放保存、主窗口焦点恢复和实际鼠标坐标映射；managed 模式内置的远端 X11 探测日志会进入同一条诊断链。普通运行默认关闭，不会增加日志。手工回退入口会写入私有 `.runtime/server.log`；Tauri 模式会在应用数据目录写入 `tauri-server.log` 和 `tauri-manager.log`。日志可能包含窗口 ID、尺寸、DISPLAY/XAUTHORITY 路径和 SSH 错误，不包含屏幕图像、剪贴板内容、私钥、VNC 密码或访问令牌；提交日志前请检查并删去主机名等环境信息。非 managed 模式的旧版远端 C helper 不会自动替换，只有部署了本版本 helper 后才会输出其 X11 `stderr` 细节。

复现顺序建议：打开一个 QQ 子窗口 → 收起/恢复 → 关闭子窗口 → 再打开同类子窗口 → 观察主窗口鼠标；然后把对应时间段的日志和现象一并保留。不要单独把 `list-qq-windows` 的 JSON 标准输出当成完整证据，详细诊断在标准错误流中。

### KDE Wayland 输入授权

如果远端第一次收到鼠标或键盘操作时出现 **「远程控制」→「应用程序正在请求特殊权限：控制输入设备」**，这是 KDE/Xwayland 对 x11vnc 注入输入的安全确认，不是 VNC 密码弹窗。允许后才能远程操作；只需要查看画面时可在本机打开「只读」，避免发送输入。程序不会绕过或自动批准该系统权限。

## 8. 安全边界

- 本地 Web/WS 只监听 `127.0.0.1`；
- VNC 只通过 SSH 转发；
- 向导输入的 VNC 密码默认保存到本机系统凭据库；不写入浏览器或 JSON 配置，取消勾选时仅缓存于当前进程内存；
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
