const $ = (id) => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get("token");
try {
  token ||= sessionStorage.getItem("qq-viewer-token");
  if (token) sessionStorage.setItem("qq-viewer-token", token);
} catch {
  /* Storage is optional. */
}
history.replaceState(null, "", location.pathname);
let report;
let busy = false;
let configured = false;
const status = (text) => {
  $("setup-status").textContent = text;
};
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-QQ-Token": token || "", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data.detail || data.error || "连接凭证无效，请重新启动软件。",
    );
  return data;
}
function updateControls() {
  $("setup-fields").disabled = busy;
  $("setup-window").disabled = busy;
  $("setup-consent").disabled = busy;
  $("setup-recover").disabled = busy;
  $("setup-back").disabled = busy || !configured;
  $("setup-save").disabled =
    busy ||
    !report?.x11vnc ||
    !report?.passwordReady ||
    !$("setup-window").value ||
    !$("setup-consent").checked;
}
function invalidate() {
  report = undefined;
  $("setup-result").hidden = true;
  $("setup-consent").checked = false;
  status("配置已修改，请重新预检；尚未保存。");
  updateControls();
}
$("setup-fields").addEventListener("input", invalidate);
$("setup-window").addEventListener("change", updateControls);
$("setup-consent").addEventListener("change", updateControls);
$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  report = undefined;
  $("setup-result").hidden = true;
  $("setup-consent").checked = false;
  updateControls();
  status("正在通过 SSH 只读检查，通常需要数秒…");
  try {
    report = await api("/api/setup/preflight", {
      name: $("setup-name").value.trim(),
      ssh: {
        host: $("setup-host").value.trim(),
        user: $("setup-user").value.trim(),
        port: Number($("setup-port").value),
        privateKeyFile: $("setup-key").value.trim(),
      },
      remotePasswordFile: $("setup-password-path").value.trim(),
    });
    const checks = [
      [true, "SSH 与 Python 3 预检通道可用"],
      [report.running, "当前用户的 QQ 进程"],
      [report.displayAccessible, "可访问 QQ 的 X11/Xwayland 会话"],
      [report.x11vnc, "x11vnc 已安装"],
      [report.passwordReady, "远端 VNC 密码文件有效且权限私有"],
      [
        report.windows.length > 0,
        `可见的 QQ 主窗口候选：${report.windows.length} 个`,
      ],
      [report.imeReady, "可选 Fcitx 候选框 helper"],
    ];
    $("setup-checks").replaceChildren(
      ...checks.map(([ok, text]) => {
        const item = document.createElement("li");
        item.textContent = `${ok ? "✓" : "待处理 ·"} ${text}`;
        return item;
      }),
    );
    const select = $("setup-window");
    select.replaceChildren(new Option("请选择主窗口", ""));
    for (const item of report.windows) {
      select.add(
        new Option(
          `${item.id} · ${item.width} × ${item.height} · DISPLAY ${item.display}`,
          item.key,
        ),
      );
    }
    if (report.windows.length === 1) select.value = report.windows[0].key;
    $("setup-result").hidden = false;
    const ready =
      report.x11vnc && report.passwordReady && report.windows.length > 0;
    $("setup-help").open = !ready;
    status(
      ready
        ? "预检完成。请核对窗口与授权范围，再保存。尚未启动远端服务。"
        : "预检完成，但还有待处理项目。按下方引导准备远端后重新预检。",
    );
  } catch (error) {
    status(error.message);
    $("setup-help").open = true;
  } finally {
    busy = false;
    updateControls();
  }
});
$("setup-save").addEventListener("click", async () => {
  if (busy || $("setup-save").disabled) return;
  busy = true;
  updateControls();
  status("正在重新核对窗口并备份、保存本机配置…");
  try {
    await api("/api/setup/save", {
      windowKey: $("setup-window").value,
      consent: $("setup-consent").checked,
      autoRecover: $("setup-recover").checked,
    });
    location.href = `./#token=${encodeURIComponent(token)}`;
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    updateControls();
  }
});
$("setup-back").addEventListener("click", () => {
  location.href = `./#token=${encodeURIComponent(token)}`;
});
try {
  const data = await api("/api/setup");
  if (!data.available)
    throw new Error(
      "首次连接向导需要 Tauri 入口。Chrome 回退入口请按 QUICKSTART.md 编辑配置。",
    );
  configured = data.configured;
  const p = data.profile || {};
  $("setup-name").value = p.name || "Linux QQ";
  $("setup-host").value = p.ssh?.host || "";
  $("setup-user").value = p.ssh?.user || "";
  $("setup-port").value = p.ssh?.port || 22;
  $("setup-key").value = p.ssh?.privateKeyFile || "";
  $("setup-password-path").value = p.vnc?.remotePasswordFile || "";
  status(data.startupError || "配置只会在确认保存时写入。首先运行只读预检。");
  updateControls();
} catch (error) {
  status(error.message);
  $("setup-fields").disabled = true;
  $("setup-help").open = true;
}
