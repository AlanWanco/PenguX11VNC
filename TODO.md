# Roadmap

## v0.2：连接工具化

- [x] JSON 连接配置档
- [x] SSH 私钥安全导入（文件权限 600，不保存口令）
- [x] 可选双向剪贴板同步
- [x] 工具栏简化：移除收起按钮与悬浮恢复球，保留系统标题栏关闭时的细栏展开按钮
- [x] 滚轮限速
- [x] 传输码率/画质档位
- [x] 可配置 VNC 请求帧率上限
- [x] 可见 QQ 子窗口递归发现与独立会话
- [x] 子窗口关闭状态实时回收与恢复
- [x] 加速子窗口监控：主连接期间通过持久 SSH 会话运行 X11/XWayland watcher，订阅窗口创建、映射、销毁等事件并增量通知；启动时全量扫描，每 15 秒全量 reconcile 兜底。watcher 随主连接退出，不安装常驻服务；真实 QQ 弹窗实机验证仍见下方待办
- [x] 提前显示本地子窗口加载页，与远端 SSH/VNC 会话准备并行；调试模式记录窗口首绘、会话就绪和 RFB/视频首帧耗时，实机是否达成 1 秒目标待验证
- [ ] 子窗口偶发关闭失败：确认 QQ 窗口、X11 销毁、x11vnc、SSH 会话和本地 Tauri 窗口之间的竞态，避免关闭后 QQ 无法再次打开
- [ ] 子窗口多次最小化/强制恢复后的断联：增加远端 VNC 存活检查、恢复和重连状态机
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
- [x] 主窗口根据 VNC 画面与 UI 外框原生锁定长宽比
- [ ] 持久化连接/退出前最后有效的主窗口与子窗口 VNC 缩放比例
- [ ] 未连接时调整窗口大小后，连接时按当前窗口可用宽高选择更小的等比缩放，不自动恢复到 1:1
- [ ] 修复开启子窗口后偶发的鼠标坐标映射错误，核对 framebuffer、canvas 显示尺寸、DPI 和 Tauri 原生窗口尺寸变化
- [x] Tauri 显式文件剪贴板上传：50 MiB 限制、SCP、远端 Downloads 与 `text/uri-list`
- [ ] 独立远程文件管理器窗口：从设置或工具栏打开，复用 SSH 配置并提供轻量远端目录浏览、远端下载到本机和本机上传。当前剪贴板文件流程仍是单向发送到远端 Downloads；实现前再评估传输协议、进度/取消、覆盖确认与跨平台路径处理
- [x] Tauri 文本剪贴板同步改用系统原生读写接口，不依赖 WebView 剪贴板 API 权限
- [ ] macOS 实机确认系统剪贴板访问授权、Finder 文件复制与原生拖放事件

- [x] GitHub Actions 未签名调试打包：macOS arm64 DMG、Linux amd64/arm64 AppImage、Windows amd64/arm64 NSIS 安装包
- [ ] Release 签名、自动更新与版本回滚
- [x] 调试安装包内置对应目标架构 Node.js（Tauri 仍使用 Node HTTP/WebSocket 过渡 bridge；源码开发仍需 Node.js）
- [ ] Windows/Linux 的 SSH agent、路径和权限适配
- [ ] Windows/Linux 剪贴板权限与 Unicode 回归测试

## v0.5：高性能视频传输（长期）

- [x] WebRTC/VP8 单窗口视频通道：SSH 信令、UDP 媒体、RFB 控制通道、无自动回退
- [x] 视频流复用码率档位与帧率上限设置；运行中变更后重新协商
- [ ] 视频编码串流与 VNC 做成可选传输后端
- [ ] 远端 GStreamer/VP8 实机长时间稳定性、CPU、码率和 30/60 FPS 对比
- [ ] 增加 H.264 编码选项并比较文字清晰度、CPU 和 WebView 兼容性
- [ ] UDP 端口范围、防火墙引导、ICE 失败诊断和跨网段/TURN 策略
- [ ] 视频流与 RFB 帧请求进一步解耦，验证主窗口和子窗口同时播放
- [ ] 评估 Sunshine/Moonlight 类低延迟视频通道或 WebRTC/H.264 方案，替代重度使用场景下的 VNC 传输；明确保留单窗口捕获、SSH/本地安全边界和跨平台输入能力

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
