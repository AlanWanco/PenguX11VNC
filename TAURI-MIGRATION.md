# Tauri 2 迁移方案

## 结论

现在适合开始迁移。noVNC 前端、JSON 配置、子窗口会话协议和安全边界已经稳定；当前 macOS 版本的主要限制是依赖 Node.js、Python、Chrome 和外部 SSH 命令。Tauri 2 可以把这些生命周期收进桌面应用，但不需要重写画面协议。

原则：**先保留 `public/`，先替换启动器，再替换本地 bridge。** 不直接大规模重写。

## 已落地：阶段 1～2

`src-tauri/` 已加入可运行的 Tauri 2 外壳：

```sh
cd qq-viewer
npm run tauri:dev
```

Rust 现在负责：

- 读取并校验连接配置；
- 复用已有主 SSH/VNC 转发，必要时创建并持有主 SSH 隧道；
- 运行远端窗口 helper；
- 为每个可见 QQ 子窗口启动远端 x11vnc 和独立 SSH 转发；
- 在子窗口消失、会话关闭或 Tauri 主窗口关闭时清理远端 PID、本地转发和全部子会话；
- 启动本地 Node 静态/WebSocket bridge，并把 Rust manager 作为唯一的 SSH/VNC/子窗口生命周期后端；
- 通过 Rust 的流式 `/ime` manager 端点运行候选框 helper，Node 不再启动 IME SSH 子进程。

Node 目前只保留 HTTP 静态服务和 VNC/IME WebSocket 代理；Tauri 版本不再调用 `tools/launch.py`，也不由 Node 创建 SSH/VNC/QQ 子窗口进程。Chrome/Python 启动器仍作为回退入口。

## 目标架构

```text
Tauri 主进程 Rust
├── ConfigStore       读取/校验 connections.json
├── SshManager        SSH 隧道、agent、-i 私钥路径、断线重连
├── VncSession        主窗口和每个子窗口的 localhost forward
├── RemoteWatcher     1 秒枚举可见 QQ X11 窗口
├── CredentialStore   Keychain / Credential Manager / libsecret
└── WindowManager     主窗口、子窗口、关闭事件和资源清理

Tauri WebView
└── 现有 noVNC UI、缩放、帧率、滚轮、剪贴板、IME PNG 叠层
```

## 分阶段实施

### 阶段 1：Tauri 外壳（已完成）

- 创建 Tauri 2 workspace；
- WebView 复用现有 `public/` 和本机 Node bridge；
- Rust 负责启动/等待 bridge、创建主窗口和关闭时清理。

### 阶段 2：Rust 管理 SSH/VNC（已完成第一版）

- Rust 使用系统 OpenSSH 命令，优先兼容 macOS、Windows OpenSSH、Linux OpenSSH；
- 私钥仍只传给 `ssh -i`，不上传远端、不读入日志；
- SSH agent 由系统负责口令交互；
- 每个 QQ 子窗口拥有独立的远端 x11vnc、SSH forward 和 Rust session；
- Rust manager 的 localhost 控制端点只接受随机 token；
- 远端窗口消失或 Tauri 窗口关闭时，按 session ID 幂等清理两端进程。

首版仍使用系统 `ssh`，便于复用 agent、跳板机、ProxyJump 和平台凭据；暂不引入 `russh`。

### 阶段 3：原生凭据和配置 UI

- macOS 使用 Keychain；
- Windows 使用 Credential Manager；
- Linux 使用 libsecret；
- 私钥导入通过原生文件选择器复制到应用私有目录，权限按平台处理；
- VNC 密码不写入 JSON；
- 配置档编辑器只负责校验和保存，不显示私钥内容。

### 阶段 4：打包与测试

- macOS `.app` / `.dmg`；
- Windows `.msi`；
- Linux AppImage / deb / rpm；
- 签名、更新和回滚；
- 测试主窗口、多个子窗口、远端窗口消失、网络断线、浏览器窗口关闭、剪贴板关闭状态和只读状态。

## IPC 设计

前端只调用白名单 command：

- `profiles.list` / `profiles.save`；
- `session.connect` / `session.disconnect`；
- `session.status`；
- `children.list` / `children.open` / `children.close`；
- `credentials.import_key`；
- `clipboard.set_sync`。

Rust 通过事件通知：

- `session-status`；
- `child-discovered`；
- `child-closed`；
- `tunnel-error`；
- `credential-required`。

不提供任意 shell command IPC，不允许 WebView 自行指定 SSH 主机、VNC 端口或远端命令。

## 迁移时必须保持

- 主 QQ 只使用已有实例，不启动第二个 QQ；
- VNC 只监听远端 localhost；
- 默认不启用剪贴板同步；
- 不捕获整个桌面；
- 不把 QQ 画面、候选词、剪贴板、私钥写入日志；
- 子窗口会话清理必须幂等；
- Android 单独处理存储、键盘、触摸和后台网络，不直接套用桌面代码。

## 下一步

1. 在真实 QQ 子窗口现场确认 Tauri 原生窗口自动连接和关闭回收；
2. 接入原生密钥选择器与 Keychain/系统凭据存储；
3. 再移除 Node WebSocket bridge，并完成 `.app`、`.msi`、AppImage/deb/rpm 打包。
