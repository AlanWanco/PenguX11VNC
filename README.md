# PenguX11VNC

## 从本机远程操作另一台 Linux 电脑上的 QQ

PenguX11VNC 在本机打开一个窗口，显示并操作另一台 Linux 电脑上正在运行的 QQ 窗口。

它通过 SSH 传输，只显示指定的 QQ 窗口：

- 不会启动第二个 QQ；
- 不会替你登录 QQ；
- 不会启动或传输远端整个桌面；
- 不需要把远端的 VNC 端口开放到网络。

## 下载

从 [Releases](https://github.com/AlanWanco/PenguX11VNC/releases/latest) 下载对应平台的安装包：

| 设备                | 文件                   |
| ------------------- | ---------------------- |
| macOS Apple Silicon | `.dmg`                 |
| Windows 64 位       | `windows-amd64.exe`    |
| Windows ARM64       | `windows-arm64.exe`    |
| Linux 64 位         | `linux-amd64.AppImage` |
| Linux ARM64         | `linux-arm64.AppImage` |

目前安装包未签名。系统第一次打开时，可能需要手动允许运行。

本机还需要 SSH 客户端：macOS 和 Linux 通常已经安装；Windows 请启用系统的 OpenSSH Client。

## 远端电脑需要准备什么

以下准备工作都在**运行 QQ 的那台 Linux 电脑**上完成：

1. 登录 Linux 图形桌面，并启动 QQ。连接时 QQ 窗口需要保持显示，不能完全隐藏。
2. 开启 SSH 服务，确保你可以从本机登录这台电脑。
3. 安装 `x11vnc`、Python 3 和 X11 图形库。它们用于读取 QQ 窗口和转发鼠标键盘操作。
4. 创建一个连接密码文件。

不同发行版的安装命令不同，常见例子如下：

```sh
# Arch Linux
sudo pacman -S x11vnc python libx11 openssh

# Debian / Ubuntu
sudo apt install x11vnc python3 libx11-6 openssh-server

# Fedora
sudo dnf install x11vnc python3 libX11 openssh-server
```

SSH 服务名因发行版不同：

- Arch/Fedora：`sudo systemctl enable --now sshd`
- Debian/Ubuntu：`sudo systemctl enable --now ssh`

确认 SSH 服务已经启动后，创建连接密码文件：

```sh
mkdir -p ~/.config/pengux11vnc
chmod 700 ~/.config/pengux11vnc
x11vnc -storepasswd ~/.config/pengux11vnc/vnc.pass
chmod 600 ~/.config/pengux11vnc/vnc.pass
```

`x11vnc -storepasswd` 会提示你输入密码。这个密码之后在 PenguX11VNC 的连接窗口中使用。

不需要手动启动 `x11vnc`，也不需要手动设置 VNC 转发。PenguX11VNC 连接时会自动启动自己的服务，断开后会清理它。

## 第一次连接

1. 在本机安装并打开 PenguX11VNC。
2. 点击「首次连接」或「配置向导」。
3. 填写远端信息：
   - **主机**：远端 Linux 的 IP 地址或主机名；
   - **端口**：SSH 端口，通常是 `22`；
   - **用户名**：运行 QQ 的 Linux 用户名；
   - **私钥**：可选。不填写时使用系统 SSH agent 或默认密钥。
4. 点击「只读预检」，等待检查完成。
5. 从窗口列表中选择 QQ，保存配置。
6. 点击「连接窗口」，输入刚才创建的连接密码。

向导会检查 SSH、QQ、图形会话、QQ 窗口和远端依赖，但不会自动安装软件，也不会启动 QQ。

第一次发送鼠标或键盘操作时，Linux 桌面可能会询问是否允许远程控制输入设备。确认后才能操作 QQ；只看画面时可以打开「只看画面」。

## 日常使用

- **适应 / 1:1**：切换窗口适应和原始像素显示；窗口可以自由调整大小。
- **只看画面**：禁止本机发送鼠标、键盘和剪贴板操作。
- **码率 / 帧率**：网络较慢时可以降低画质或帧率。
- **实验性视频流**：主页连接前选择 WebRTC/VP8/60 FPS；RFB 只负责键鼠与剪贴板，连接后不支持中途切换，需要远端 GStreamer 和 UDP 防火墙规则，失败不会自动回退到 VNC，而是回到主页重新选择，默认使用标准 VNC。
- **文件拖放**：Tauri 连接后可将普通文件拖入窗口，确认后上传到远端 Downloads，再在 QQ 中手动按 `Ctrl+V`。
- **子窗口**：开启后，QQ 的可见子窗口会分别打开连接窗口。
- **窗口切换**：连接期间如果 QQ 被最小化，程序会尝试恢复；在本机切换主窗口或子窗口时，对应的远端窗口会置前，减少窗口重叠造成的误点击。
- **关闭窗口**：通常只会隐藏到托盘或菜单栏；选择「退出 PenguX11VNC」才会停止连接。
- **断开连接**：只断开本次连接，不会关闭远端 QQ。

### 剪贴板和文件

文本剪贴板默认不会自动同步，可以在设置中开启。

发送文件时：

1. 在 PenguX11VNC 窗口按 `Ctrl+V`；
2. 确认要上传的文件；
3. 切换到 QQ 输入框，再按一次 `Ctrl+V`。

文件会先通过 SSH 上传到远端的 Downloads 文件夹，再交给 QQ。单次最多 64 个普通文件，合计不超过 50 MiB；不会自动发送 QQ 消息。

## 常见问题

### 窗口列表里没有 QQ

确认 QQ 已登录、窗口没有最小化到完全隐藏，并且 PenguX11VNC 登录的 SSH 用户与运行 QQ 的用户相同。也可以先在远端桌面确认 QQ 窗口确实可见。

### SSH 能登录，但预检失败

确认远端安装了 `x11vnc`、Python 3 和 X11 图形库，并且 SSH 登录的是正在运行 QQ 的用户。不要只在一个没有图形环境的 SSH shell 中判断 QQ 是否可用，直接使用向导预检。

### 文件上传后 QQ 没有文件

上传完成后，需要在 QQ 输入框中再次按 `Ctrl+V`。应用不会自动粘贴或发送消息。

### 候选框没有显示

候选框叠层是实验功能，需要 QQ 获得焦点。目前只支持 X11/XWayland 的 Fcitx 弹窗；原生 Wayland 弹窗可能无法显示。

## 兼容性说明

PenguX11VNC 不限定某个 Linux 发行版；发行版主要影响依赖的安装方式。

目前远端画面捕获针对 Linux 上的 X11/XWayland 应用窗口。KDE Plasma Wayland + XWayland 已实际验证；其他桌面环境如果 QQ 也是 X11/XWayland 窗口，通常可以尝试。原生 Wayland 窗口目前不支持。

## 手动配置与开发

普通用户使用软件内向导即可。需要手动 SSH/VNC 配置、旧版 Chrome/Python 启动器或完整字段说明时，请查看 [QUICKSTART.md](QUICKSTART.md)。

配置文件默认位于：

- `~/.config/pengux11vnc/connections.json`
- `~/.config/pengux11vnc/settings.json`

旧版本配置仍可读取；使用向导保存时会迁移到新路径。

源码开发需要 Node.js 22+、Rust/Cargo 和系统 `ssh`：

```sh
npm ci
npm run tauri:dev
```

运行测试：

```sh
npm test
npm run test:browser
cargo test --manifest-path src-tauri/Cargo.toml
```

应用只监听本机端口，远端服务只监听远端本机地址，通信由 SSH 加密。不要把本地服务反代到公网，也不要分享运行时配置、连接密码或私钥。

## 许可

PenguX11VNC 外层代码使用 MIT 许可证。noVNC 使用 MPL-2.0，详见仓库中的第三方许可证文件。
