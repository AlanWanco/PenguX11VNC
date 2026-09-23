# PenguX11VNC 0.2.0

## 更新内容

- 将可见 QQ 子窗口监控改为事件驱动：主连接期间通过 SSH 运行 X11/XWayland watcher，窗口变化实时通知；初始扫描和 15 秒 reconcile 用于兜底。主连接结束后 watcher 随之退出，不安装远端常驻服务。
- 子窗口的本地窗口会先显示连接准备状态，再并行建立远端 SSH/VNC 会话；会话就绪后自动切换到画面。连接准备时间仍取决于 SSH 和远端环境，不承诺固定的端到端时延。
- 调试模式可记录子窗口首绘、会话就绪和 RFB/视频首帧的耗时。

## 安装包

此 Release 提供 macOS Apple Silicon、Windows x64/ARM64、Linux x64/ARM64 安装包，并附 SHA-256 校验文件。

安装包目前未签名；首次启动时，操作系统可能显示安全提示。使用说明和远端依赖见 [README](https://github.com/AlanWanco/PenguX11VNC/blob/main/README.md)。
