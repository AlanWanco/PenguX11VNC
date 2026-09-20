# Roadmap

## v0.2：连接工具化

- [x] JSON 连接配置档
- [x] SSH 私钥安全导入（文件权限 600，不保存口令）
- [x] 可选双向剪贴板同步
- [x] 可收起 Web UI、边缘展开、悬浮恢复球
- [x] 滚轮限速
- [x] 传输码率/画质档位
- [x] 可配置 VNC 请求帧率上限
- [x] 可见 QQ 子窗口递归发现与独立会话
- [x] 子窗口关闭状态实时回收与恢复
- [ ] 子窗口真实弹窗场景回归测试（已验证 X11 helper 和独立 VNC；仍需用户现场确认自动弹窗流程）
- [x] Tauri 首次连接向导与软件内 SSH/依赖/密码文件/窗口状态引导
- [x] 只读预检、自动发现会话与 QQ 主窗口，多候选时人工选择
- [x] 授权后的独立 localhost 主窗口 VNC、断开/退出回收
- [x] 主窗口重启恢复状态机（唯一同身份候选才恢复；隐藏/歧义暂停）
- [ ] 真实 QQ 重启、注销、多显示会话及网络断开后的现场恢复回归
- [ ] 多 profile 切换/导入导出与原生密钥文件选择器
- [x] 向导托管主会话的 SSH/VNC 断线重连和等待提示（手动模式不自动接管）

## v0.3：Tauri 桌面版

详细设计见 [TAURI-MIGRATION.md](TAURI-MIGRATION.md)。

目标平台：macOS、Windows、Linux。

- [x] Tauri 2 外壳：Rust 启动 Node bridge、创建主窗口并在关闭时清理
- [x] Rust 接管主 SSH 隧道、远端窗口 helper、子窗口 x11vnc/SSH 转发和回收
- [x] Rust manager 接管 IME 图片通道 SSH 子进程（Node 仅做代理）
- [ ] 原生文件选择器导入 SSH 私钥
- [ ] 系统密钥环/Keychain/Credential Manager/libsecret 保存 VNC 密码和私钥口令引用
- [x] 原生多窗口：Tauri 页面使用 WebviewWindow 创建 QQ 子窗口；Chrome 回退仍使用 window.open()
- [x] WebView 承载 noVNC 画布；复用现有 `public/qq-rfb.js` 和 UI

- [x] GitHub Actions 未签名调试打包：macOS arm64 DMG、Linux amd64/arm64 AppImage、Windows amd64/arm64 NSIS 安装包
- [ ] Release 签名、自动更新与版本回滚
- [x] 调试安装包内置对应目标架构 Node.js（Tauri 仍使用 Node HTTP/WebSocket 过渡 bridge；源码开发仍需 Node.js）
- [ ] Windows/Linux 的 SSH agent、路径和权限适配
- [ ] Windows/Linux 剪贴板权限与 Unicode 回归测试

### Tauri 实现边界

Rust 层负责：

1. 读取并校验连接配置；
2. 私钥文件选择和权限/访问控制；
3. SSH tunnel 与远端 helper 的启动、重连、停止；
4. 本地 WebSocket/TCP bridge；
5. 子窗口会话清理。

前端负责：

1. noVNC/RFB；
2. 缩放、滚轮、剪贴板开关；
3. UI 与窗口状态；
4. 候选框图片叠层。

## v0.4：Android 平板

- [ ] Tauri mobile 或独立 Android 容器方案评估
- [ ] SSH 私钥通过系统文件选择器导入，放入 Android Keystore/加密存储
- [ ] 支持密码、私钥、agent/跳板机策略
- [ ] 横屏优先，画面双指缩放/拖动，虚拟鼠标和滚轮
- [ ] Android 剪贴板读写权限和用户确认
- [ ] 软键盘映射 Ctrl、Alt、F11、方括号
- [ ] 子窗口以标签页或可切换会话呈现，而不是无限弹窗
- [ ] 低带宽模式、后台断线策略、电量/网络变化处理
- [ ] Play Store/F-Droid 发布前的密钥和隐私审查

## 必须保持

- 不启动第二个 QQ；
- 不把 VNC/SSH 端口暴露公网；
- 不默认同步剪贴板；
- 不默认保存私钥口令；
- 不把 QQ 画面、候选词、剪贴板内容写入日志；
- 不用全桌面捕获替代单窗口捕获；
- 不因 Android/Tauri 适配改动 Linux 的 Rime 主题和学习数据。
