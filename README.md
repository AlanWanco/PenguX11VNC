# PenguX11VNC

PenguX11VNC 是本地 noVNC 窗口连接工具，复用 CachyOS 上已经运行、仍显示在本地屏幕的 QQ。**不创建 QQ 实例、不启动远端桌面、不修改输入法主题。**

## 快速开始

给使用者看的安装和配置步骤只有一份：**[QUICKSTART.md](QUICKSTART.md)**。先看它，再运行启动器。

```sh
npm ci
npm run tauri:dev
```

### 新设备不再需要手填 XID

Tauri 会先打开界面，不再等待 SSH/VNC 就绪。缺少配置时进入软件内向导；已有配置可点击「首次连接 / 更换设备」或设置中的「配置向导与故障引导」。

1. 填写 SSH 主机、用户名、端口及可选本机私钥路径。
2. 点击**只读预检**，检查远端依赖、QQ 进程、图形会话、可见窗口和 VNC 密码文件。
3. 单一候选自动选择；多个候选必须手动确认。程序不读取聊天标题，不按最大窗口猜测。
4. 确认只允许 localhost 单窗口 VNC 后保存；旧配置先备份，其他配置档保留。
5. 返回点击连接，才启动本工具独立管理的 x11vnc/SSH；首次输入远端准备好的 VNC 密码时，可选择保存到本机系统凭据库。

软件内包含 SSH 指纹/agent、远端依赖、密码文件准备、QQ 隐藏和 Wayland 限制的引导。**并非远端零准备**：仍需同用户 Linux 图形会话、已运行的 QQ、SSH、Python 3、libX11、x11vnc 和私有 VNC 密码文件；安装和密码初始化需用户在远端确认执行。

开启自动恢复后，每轮检查完成再等 5 秒。QQ 重启只恢复到同一可执行文件/类名/实例名的唯一可见普通窗口；窗口隐藏或有歧义时暂停，绝不回退全桌面。主动断开会取消恢复并清理本次自建 VNC，不影响 QQ、输入法或已有 VNC/共享隧道。

现有手动配置仍可沿用原来的 VNC；要启用主窗口自动发现、托管和恢复，需完成向导授权。Chrome/Python 回退入口仍使用手工配置，不具备此向导。

完整路线图：**[TODO.md](TODO.md)**；Tauri 迁移方案：**[TAURI-MIGRATION.md](TAURI-MIGRATION.md)**。

## 使用

在 Finder 双击 **`启动 PenguX11VNC.command`**，然后点击「连接窗口」。旧的 `启动 QQ 窗口.command` 仍保留兼容。

Tauri 2 版本可运行。应用图标套件位于 `src-tauri/icons/`，包含 macOS `.icns`、Windows `.ico` 和多尺寸 PNG。

GitHub Actions 的 `Build debug bundles` 会为每次 push/PR 生成 5 个可下载产物：macOS arm64 `.dmg`、Linux amd64/arm64 `.AppImage`、Windows amd64/arm64 NSIS 安装包。每个平台每次只上传一个文件，保留 14 天；产物内置对应架构 Node.js，不需要另装 Node.js。它们未签名，仅用于调试。

```sh
npm run tauri:dev
```

它会用 Tauri WebView 打开本地 bridge；Rust 已接管主 SSH 隧道、远端 x11vnc、子窗口 SSH 转发和回收，Node 只暂时保留本地 HTTP/WebSocket 代理。

- 顶部「适应」：保持宽高比；「1:1」：原始像素。
- 「设置 → 传输码率」默认无损，也可选择高/均衡/低档 JPEG；VNC 按画面变化压缩，不承诺固定 Mbps。
- 「设置 → 帧率上限」可选 5/10/15/24/30/60 FPS 或不限；通过控制 VNC 增量请求频率限流，不修改远端 QQ 刷新率。
- 「设置 → 滚轮灵敏度」默认 **25%**，可在 5%～100% 调节，只影响本连接；主窗口设置会保存到 `~/.config/qq-window-viewer/settings.json`，下次启动继续使用。
- 默认使用 ZRLE 等无损编码；低码率档才广告 Tight/JPEG，不请求修改远端分辨率。
- 原有 Ctrl+Space、`[` / `]`、F11 仍交给远端 Fcitx/Rime。浏览器或 macOS 抢占的快捷键需另行处理。
- 「只看画面」可禁止本客户端发送键盘、鼠标和剪贴板。
- 剪贴板**默认不自动同步**；设置中可选开启双向同步，也可手动提交文本。若服务器没有协商 Unicode 扩展，会阻止中文传送，避免出现问号；不会自动粘贴或发送 QQ 消息。
- 「收起」会隐藏四周 Web UI，但保留底部状态栏；鼠标移到顶部边缘暂时展开，悬浮球可拖动并记住位置。点击设置面板外的空白区域会关闭设置。关闭 Tauri 系统标题栏后，顶部默认是细深紫色工具条，点击右侧按钮可暂时展开控制按钮。
- 默认推荐 Tauri 2 外壳；旧 Chrome 回退入口使用独立 app 窗口和 `.runtime/chrome-profile`，不改个人 Chrome 配置。迁移进度见 [TAURI-MIGRATION.md](TAURI-MIGRATION.md)。
- 可见的 QQ 同类子窗口可由配置档自动发现，并为每个子窗口打开独立前端窗口；子窗口页面会自动连接，不再需要手动点「连接窗口」。子窗口继承主窗口的码率、帧率、滚轮、缩放、只读、剪贴板和收起设置，主窗口修改后已打开的子窗口也会同步。枚举会递归 X11 窗口树并兼容 `QQ`/`Qq` 类名。隐藏或未映射的窗口不会捕获；Tauri Rust manager 负责 Linux 子窗口对应的远端 VNC、SSH 会话和自动清理。
- 关闭 Tauri 主窗口不会退出 QQ；Tauri 会停止本次 Node 代理并清理 Rust 子会话，但保留共享 SSH 隧道。旧 Chrome 回退入口仍可复用后台 bridge。

### 配置档和私钥

默认读取 `~/.config/qq-window-viewer/connections.json`；这是为兼容已有安装保留的内部路径，项目品牌为 PenguX11VNC。模板是 `connections.example.json`，字段说明见 [QUICKSTART.md](QUICKSTART.md)。

```sh
python3 tools/import-key.py ~/.ssh/id_ed25519
ssh-add ~/.config/qq-window-viewer/keys/id_remote  # 加密私钥可选
```

启动器支持 `--config` 和 `--profile`；私钥路径只进入本机 SSH 命令，不会上传到远端。

### 环境要求

- 源码开发的 Tauri 入口：Rust/Cargo、Node.js 22+、系统 `ssh`；不需要 Chrome/Python。GitHub Actions 下载的安装包已内置对应架构 Node.js，但仍需要系统 `ssh` 和远端依赖。
- 旧 Chrome 回退入口：Node.js 22+、Python 3、Google Chrome。
- `npm ci` 安装锁定依赖（noVNC 1.7.0、ws 8.21.3）；`npm run tauri:build` 可构建单一指定格式，GitHub Actions 负责跨平台调试打包。
- SSH 连接目标由本机配置指定；手动模式要求已有 localhost VNC，向导托管模式在连接时为选定窗口启动独立 localhost VNC。
- 手动模式/旧启动器优先复用既有 SSH 隧道。向导模式使用独立随机本机端口，不接管已有服务；远端服务只在授权后连接时创建。
- 手工配置可指定本机 VNC 密码文件，要求当前用户拥有、权限 600。向导模式默认将输入的密码保存到本机系统凭据库，不写入浏览器或 JSON 配置；取消勾选后仅在本次运行中缓存。
- VNC 密码文件是**可逆混淆**，不是安全加密；不要公开。旧临时密码应另行更换。

## 候选框补采集（实验性）

`x11vnc -id` 只导出 QQ 窗口，Fcitx popup 是独立窗口。当前添加第二条经过 SSH 的只读图片通道；Tauri 入口由 Rust manager 运行 SSH helper，旧 Chrome 回退入口仍由 `ime-bridge.js` 运行：

```
QQ 窗口 → x11vnc :5900 → SSH :15900 → 本机 WS → noVNC
Fcitx popup → capture-ime → SSH stdout → 本机认证 WS → 等比例 PNG 叠层
```

远端新 helper：`~/.local/lib/qq-window-viewer/capture-ime`。

- 只有指定 QQ 窗口获得 X11 焦点时才采集。
- 仅接受 **可见、override-redirect、WM_CLASS=fcitx** 的单个弹窗，并检查与 QQ 的空间交集。
- 隐藏、失焦、多个候选窗口、捕获错误时不发送图片；不捕获 root/其他应用，也不注入输入。
- PNG 仅通过内存传输，不写候选词截图或文字日志。相同内容不重复编码发送，每 5 秒心跳。
- 前端按 QQ framebuffer 的相同比例、相对位置叠加。失连或停止收到心跳时隐藏。
- **真实可见候选框尚待人工确认**；已验证 helper 编译、隐藏状态、通道握手，以及模拟候选框在三种尺寸中的位置。
- 当前 helper 只支持 X11/Xwayland popup。若 Fcitx 使用原生 Wayland popup、QQ 失焦、候选框超出可显示区域或开新窗口，可能仍不可见/被裁切。不是通用多窗口桌面共享。
- Tauri 入口的 Rust manager 从连接档读取 `DISPLAY`、XAUTHORITY、SSH 主机和 QQ XID；旧 Chrome 回退入口由 `ime-bridge.js` 读取同一配置。手动模式下注销或 QQ 完全重启后仍需重新检查配置；向导模式会重新发现会话，歧义时停止并提示。

本次远端 x11vnc 原有 `-xwarppointer` 保持不变，用于避免 Xwayland 的 XTEST 坐标偏移。

## 本地安全边界

- HTTP/WS **只监听 127.0.0.1 的随机端口**，不监听 LAN。
- WS 同时检查 Host、Origin、每次服务启动生成的 256 位 token；上游目标来自已校验的连接档，不能由网页任意指定目标。
- token 从 URL fragment 导入后移除，只保留在当前会话；不是 VNC 密码。
- 密码 API 需要 token，无 CORS；静态服务器只开放 `public/` 和 noVNC JS，不开放源码、配置、runtime 或密码文件。
- 本地连接未使用 TLS；Linux↔Mac 传输由既有 SSH 隧道加密。不要把本机服务反代到公网。
- Tauri 的应用数据目录保存会话记录和日志（会话文件/日志在 Unix 上为 600）；旧 Chrome 回退入口的 `.runtime/` 为 700。它们包含私有访问链接，均不要上传。
- npm 自带 noVNC 源码可供本地修改，当前通过 `public/qq-rfb.js` 小型适配层扩展，不改 `node_modules`。仓库只包含脱敏源码，运行配置不纳入版本控制。

## 开发与验证

```sh
npm test
npm run test:browser       # 使用已安装的 Chrome，始终 headless
python3 tools/launch.py --no-open
node test/onboarding-browser.mjs  # 隔离的向导/恢复浏览器测试，不访问远端
python3 -m unittest discover -s test -p 'test_remote_session.py'
cargo test --manifest-path src-tauri/Cargo.toml
```

已覆盖：服务边界/路径访问/认证、VNC 密码文件格式、配置档校验、无损编码协商、帧率请求控制、三种窗口比例、点击坐标、候选框叠层位置、F11/方括号、25% vs 100% 的协议滚轮步数、收起状态栏/悬浮球拖动、只读模式、断开重连及 Unicode 降级保护、首次连接向导的预检/歧义选择/授权门、恢复与主动停止。真实连接确认收到非黑图像 `1669×1147`。

滚轮算法按事件累积：像素/行/页统一单位，反向和长空闲清掉余量；单次最多 2 步，输出间隔至少 32ms，无定时队列补滚。25% 是归一化输入的增益，不保证每种鼠标/驱动的主观速度恰好为 TurboVNC 的四分之一。

noVNC 私有钩子 `_handleWheel`、`_sendEncodings`、剪贴板能力字段集中在 `public/qq-rfb.js`，升级依赖必须重新跑浏览器/协议回归测试。

## 停止与回退

Tauri 主窗口关闭会停止本次 Node 代理、IME SSH 和 Rust 子窗口；不会停止共享 SSH 隧道、远端 QQ、Fcitx 或主 x11vnc。旧 Chrome 回退入口可使用 `python3 tools/stop.py`。

重新打开 TurboVNC 即可使用原来的连接。要恢复其正常等比例参数，应使用 `Scale=FixedRatio`，不是 `Auto`。

远端 helper/托管 VNC 不是常驻系统服务。本工具不会更改输入法/桌面配置。真实 QQ 重启后的恢复及多设备组合仍需现场验证；当前自动化测试使用模拟服务，已做现有 Linux 环境的只读预检验证。

## 许可

PenguX11VNC 外层代码使用 MIT；noVNC core 使用 MPL-2.0，详见 `node_modules/@novnc/novnc/LICENSE.txt` 及 `docs/` 的许可证；`public/qq-rfb.js` 包含基于上游实现的适配，也以 MPL-2.0 提供；ws 为 MIT。其余外层定制 UI 与辅助代码置于 `LICENSE` 的 MIT 条款下。分发时保留第三方许可，并履行对应 MPL 源码义务。
