# PenguX11VNC

在本机打开一个窗口，连接到另一台 Linux 电脑上已经运行的 QQ。

PenguX11VNC 通过 SSH 连接，只捕获指定的 QQ 窗口：

- 不启动第二个 QQ；
- 不启动远端桌面；
- 不捕获整个屏幕；
- 不需要把 VNC 端口暴露到局域网或公网。

## 下载

前往 [Releases](https://github.com/AlanWanco/PenguX11VNC/releases/latest) 下载对应版本：

| 平台 | 文件 |
| --- | --- |
| macOS Apple Silicon | `.dmg` |
| Windows 64 位 | `windows-amd64.exe` |
| Windows ARM64 | `windows-arm64.exe` |
| Linux 64 位 | `linux-amd64.AppImage` |
| Linux ARM64 | `linux-arm64.AppImage` |

目前发布包未签名。首次打开时，系统可能需要手动确认。

## 开始之前

远端 Linux 电脑需要满足以下条件：

- QQ 已登录，并显示在当前图形桌面中；
- QQ 使用 X11 或 XWayland；
- SSH 服务可以登录；
- 已安装 `x11vnc`、Python 3 和 libX11；
- 已准备一个仅当前用户可读的 VNC 密码文件。

KDE Plasma Wayland + XWayland 是目前验证过的环境。纯 Wayland 原生窗口暂不支持；GNOME、其他 X11 桌面或 Wayland compositor 只要能提供可访问的 X11/XWayland 窗口，通常可以使用，但仍可能需要单独验证。

不需要手动启动常驻 VNC 服务。连接时，PenguX11VNC 会启动自己的 `x11vnc`，并通过 SSH 建立隧道；断开后会清理自己启动的进程。

### 准备 VNC 密码文件

如果远端还没有密码文件，可以在远端执行：

```sh
mkdir -p ~/.config/pengux11vnc
chmod 700 ~/.config/pengux11vnc
x11vnc -storepasswd ~/.config/pengux11vnc/vnc.pass
chmod 600 ~/.config/pengux11vnc/vnc.pass
```

密码文件不是明文密码，也不要上传到代码仓库或发送给别人。

## 第一次连接

1. 安装并打开 PenguX11VNC。
2. 点击「首次连接」或「配置向导」。
3. 填写远端 SSH 主机、端口、用户名，以及可选的本机私钥。
4. 点击「只读预检」。
5. 选择要连接的 QQ 窗口，确认后保存。
6. 点击「连接窗口」，输入 VNC 密码。

向导会检查 SSH、QQ 进程、图形会话、QQ 窗口、`x11vnc` 和密码文件，但不会替你安装远端软件，也不会启动 QQ。

如果 KDE 第一次提示应用请求控制输入设备，请在远端确认。只查看画面时，可以打开「只看画面」以禁止键盘和鼠标输入。

## 日常使用

- **适应 / 1:1**：在保持比例和原始像素之间切换；窗口可以自由调整大小。
- **只看画面**：禁止本机向 QQ 发送键盘、鼠标和剪贴板操作。
- **码率和帧率**：默认优先画质，也可以降低画质或帧率来减少流量。
- **子窗口**：启用后，QQ 的可见子窗口会分别打开连接窗口；关闭后会自动回收对应会话。
- **托盘/菜单栏**：关闭主窗口通常只会隐藏应用；选择「退出 PenguX11VNC」才会停止连接。
- **断开连接**：只停止本次 SSH/VNC 会话，不会关闭远端 QQ。

### 剪贴板和文件

文本剪贴板默认不自动同步，可以在设置中开启。

发送文件时：

1. 在 PenguX11VNC 中按 `Ctrl+V`，确认上传文件；
2. 文件会通过 SSH 上传到远端 Downloads；
3. 切换到 QQ，再按一次 `Ctrl+V`。

单次最多 64 个普通文件，合计不超过 50 MiB。PenguX11VNC 不会自动粘贴、发送 QQ 消息或重复上传没有变化的文件。

## 遇到问题

### 找不到 QQ 窗口

确认 QQ 已登录、窗口没有完全隐藏，并且 PenguX11VNC 与 QQ 使用同一个 Linux 用户。QQ 必须是 X11/XWayland 窗口；原生 Wayland 窗口目前不能捕获。

### SSH 可以登录，但预检失败

确认远端安装了 `x11vnc`、Python 3 和 libX11，并且 SSH 登录的是正在运行 QQ 的用户。不要只在没有图形环境的 SSH shell 中检查 `DISPLAY`；使用向导预检更可靠。

### 鼠标位置偏移

远端手动启动 `x11vnc` 时必须保留 `-xwarppointer`。托管模式会自动使用该选项。

### 文件上传后 QQ 没有文件

上传完成后还需要在 QQ 输入框中再次按 `Ctrl+V`。文件会先放入远端 `Downloads`，不会自动发送消息。

### 候选框没有显示

候选框叠层目前是实验功能，只支持 X11/XWayland 的 Fcitx 弹窗，并且 QQ 需要获得焦点。原生 Wayland popup 可能无法显示。

## 配置文件

新版本默认使用以下路径：

- 连接配置：`~/.config/pengux11vnc/connections.json`
- 界面设置：`~/.config/pengux11vnc/settings.json`
- 私钥目录：`~/.config/pengux11vnc/keys/`
- 本机 VNC 密码：`~/.config/pengux11vnc/vnc.pass`

旧版本配置仍可读取；使用向导保存时会迁移到新路径。完整的手动配置说明见 [QUICKSTART.md](QUICKSTART.md)。

## 高级用户与开发者

手动 SSH/VNC 模式、旧版 Chrome/Python 启动器和远端字段说明见 [QUICKSTART.md](QUICKSTART.md)。

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

应用只监听本机随机端口，远端 VNC 只监听 localhost，通信由 SSH 加密。请不要把本地服务反代到公网，也不要分享运行时配置、令牌、密码或私钥。

## 许可

PenguX11VNC 外层代码使用 MIT 许可证。noVNC 使用 MPL-2.0，详见仓库中的第三方许可证文件。
