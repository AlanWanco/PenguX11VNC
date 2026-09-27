const $ = (id) => document.getElementById(id);
const SESSION_TOKEN_KEY = "pengux11vnc-token";
const SESSION_LEGACY_TOKEN_KEY = "qq-viewer-token";
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get("token");
try {
  token ||=
    sessionStorage.getItem(SESSION_TOKEN_KEY) ||
    sessionStorage.getItem(SESSION_LEGACY_TOKEN_KEY);
  if (token) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.removeItem(SESSION_LEGACY_TOKEN_KEY);
  }
} catch {
  /* Storage is optional. */
}
history.replaceState(null, "", location.pathname);
let report;
let busy = false;
const status = (text) => {
  $("setup-status").textContent = text;
};
function formDraft() {
  return {
    name: $("setup-name").value,
    host: $("setup-host").value,
    port: $("setup-port").value,
    user: $("setup-user").value,
    key: $("setup-key").value,
    passwordPath: $("setup-password-path").value,
  };
}
function draftRequest() {
  const draft = formDraft();
  return {
    name: draft.name,
    ssh: {
      host: draft.host,
      port: draft.port,
      user: draft.user,
      privateKeyFile: draft.key,
    },
    remotePasswordFile: draft.passwordPath,
  };
}
function applyFormValues(value) {
  if (!value) return;
  $("setup-name").value = value.name || "Linux QQ";
  $("setup-host").value = value.host || "";
  $("setup-user").value = value.user || "";
  $("setup-port").value = value.port || 22;
  $("setup-key").value = value.key || "";
  $("setup-password-path").value = value.passwordPath || "";
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-PenguX11VNC-Token": token || "",
      "Content-Type": "application/json",
    },
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
  $("setup-recover").disabled = busy;
  $("setup-back").disabled = busy;
  $("setup-save").disabled = busy;
}
function invalidate() {
  report = undefined;
  $("setup-result").hidden = true;
  status("配置已修改，请重新预检；尚未保存。");
  updateControls();
}
$("setup-fields").addEventListener("input", invalidate);
$("setup-window").addEventListener("change", updateControls);
$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  report = undefined;
  $("setup-result").hidden = true;
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
    const passwordPath = report.passwordFile || "自动默认路径";
    const passwordCheck = report.passwordReady
      ? `远端 VNC 密码文件有效且权限私有（使用 ${passwordPath}）`
      : `远端 VNC 密码文件待处理（已检查 ${passwordPath}）`;
    const checks = [
      [true, "SSH 与 Python 3 预检通道可用"],
      [report.running, "当前用户的 QQ 进程"],
      [report.displayAccessible, "可访问 QQ 的 X11/Xwayland 会话"],
      [report.x11vnc, "x11vnc 已安装"],
      [report.passwordReady, passwordCheck],
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
        ? "预检完成。确认所选 QQ 窗口后，点击唯一的“保存配置并返回首页”按钮。尚未启动远端服务。"
        : `预检完成，但还有待处理项目。${
            report.passwordReady
              ? "按下方引导准备远端后重新预检。"
              : `未找到有效的远端 VNC 密码文件；留空会自动检查默认路径（${passwordPath}）。`
          }`,
    );
  } catch (error) {
    const item = document.createElement("li");
    item.textContent = `预检失败 · ${error.message}`;
    $("setup-checks").replaceChildren(item);
    $("setup-window").replaceChildren(new Option("预检成功后选择主窗口", ""));
    $("setup-result").hidden = false;
    status(error.message);
    $("setup-help").open = true;
  } finally {
    busy = false;
    updateControls();
  }
});
$("setup-save").addEventListener("click", async () => {
  if (busy || $("setup-save").disabled) return;
  if (!$("setup-form").reportValidity()) return;
  busy = true;
  updateControls();
  const selectedWindow = $("setup-window").value;
  const canSaveVerifiedProfile =
    report?.x11vnc && report?.passwordReady && selectedWindow;
  status(
    canSaveVerifiedProfile
      ? "正在重新核对所选窗口并保存完整配置…"
      : "正在备份并保存本机连接资料…",
  );
  try {
    const data = canSaveVerifiedProfile
      ? await api("/api/setup/save", {
          windowKey: selectedWindow,
          autoRecover: $("setup-recover").checked,
        })
      : await api("/api/setup/draft", draftRequest());
    if (canSaveVerifiedProfile && !data.configured)
      throw new Error("完整连接配置未确认保存");
    if (!canSaveVerifiedProfile && !data.savedLocally)
      throw new Error("本机连接资料未确认保存");
    location.href = `./#token=${encodeURIComponent(token)}`;
  } catch (error) {
    status(`保存失败：${error.message}。填写内容仍保留在当前页面。`);
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
  const p = data.profile || {};
  const profileValues = {
    name: p.name || "Linux QQ",
    host: p.ssh?.host || "",
    user: p.ssh?.user || "",
    port: p.ssh?.port || 22,
    key: p.ssh?.privateKeyFile || "",
    passwordPath: p.vnc?.remotePasswordFile || "",
  };
  applyFormValues(profileValues);
  status(
    data.startupError ||
      "填写连接资料后运行只读预检；点击唯一的保存按钮即可保存并返回首页。",
  );
  updateControls();
} catch (error) {
  status(error.message);
  $("setup-fields").disabled = true;
  $("setup-help").open = true;
}
