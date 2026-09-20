//! Native tray/menu-bar lifecycle. Only the main window is hidden; QQ children
//! retain their native close contract and per-session cleanup.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Theme,
};

const TRAY_ID: &str = "pengux11vnc-tray";
const BLACK: &[u8] = include_bytes!("../icons/tray-black.png");
const WHITE: &[u8] = include_bytes!("../icons/tray-white.png");

struct TrayState {
    available: AtomicBool,
    hidden: AtomicBool,
    quitting: AtomicBool,
    stopped: Arc<AtomicBool>,
    dark: Mutex<bool>,
}

impl Drop for TrayState {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    HideMain,
    ExitMain,
    CloseChild,
    Ignore,
}

fn decide_close(label: &str, available: bool, quitting: bool) -> CloseAction {
    if label == "main" {
        if available && !quitting {
            CloseAction::HideMain
        } else {
            CloseAction::ExitMain
        }
    } else if label.starts_with("qq-child-") {
        CloseAction::CloseChild
    } else {
        CloseAction::Ignore
    }
}

pub fn close_action(app: &AppHandle, label: &str) -> CloseAction {
    let state = app.try_state::<TrayState>();
    decide_close(
        label,
        state
            .as_ref()
            .is_some_and(|s| s.available.load(Ordering::Acquire)),
        state
            .as_ref()
            .is_some_and(|s| s.quitting.load(Ordering::Acquire)),
    )
}

pub fn restore_main(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.show()?;
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        if let Some(state) = app.try_state::<TrayState>() {
            state.hidden.store(false, Ordering::Release);
        }
    }
    Ok(())
}

pub fn hide_main(app: &AppHandle) -> tauri::Result<()> {
    if close_action(app, "main") != CloseAction::HideMain {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("main") {
        // hide(), not close()/destroy(): keep the WebView, Node, SSH and VNC alive.
        window.hide()?;
        if let Some(state) = app.try_state::<TrayState>() {
            state.hidden.store(true, Ordering::Release);
        }
    }
    Ok(())
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.quitting.store(true, Ordering::Release);
        state.stopped.store(true, Ordering::Release);
    }
}

fn icon(dark: bool) -> tauri::Result<Image<'static>> {
    Image::from_bytes(if dark { WHITE } else { BLACK })
}

// Windows' taskbar theme can differ from AppsUseLightTheme. Read only the
// system value, including while the main window is hidden.
fn panel_is_dark(app: &AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
        {
            if let Ok(light) = key.get_value::<u32, _>("SystemUsesLightTheme") {
                return light == 0;
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Plasma's Qt palette may change without GTK emitting ThemeChanged.
        let kde = std::env::var("XDG_CURRENT_DESKTOP")
            .unwrap_or_default()
            .split(':')
            .any(|desktop| desktop.eq_ignore_ascii_case("KDE"));
        if kde {
            let config = std::env::var_os("XDG_CONFIG_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .map(|home| std::path::PathBuf::from(home).join(".config"))
                });
            if let Some(dark) = config
                .and_then(|config| std::fs::read_to_string(config.join("kdeglobals")).ok())
                .and_then(|text| kde_background_is_dark(&text))
            {
                return dark;
            }
        }
    }
    app.get_webview_window("main")
        .and_then(|window| window.theme().ok())
        != Some(Theme::Light)
}

#[cfg(any(target_os = "linux", test))]
fn kde_background_is_dark(text: &str) -> Option<bool> {
    let mut window_colors = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            window_colors = line == "[Colors:Window]";
        } else if window_colors {
            if let Some(("BackgroundNormal", value)) = line.split_once('=') {
                let rgb: Vec<u8> = value
                    .split(',')
                    .map(|v| v.trim().parse())
                    .collect::<Result<_, _>>()
                    .ok()?;
                if let [red, green, blue] = rgb.as_slice() {
                    let luminance =
                        299 * u32::from(*red) + 587 * u32::from(*green) + 114 * u32::from(*blue);
                    return Some(luminance < 128_000);
                }
            }
        }
    }
    None
}

pub fn refresh_theme(app: &AppHandle) {
    // NSImage template tint follows the actual menu-bar background, wallpaper
    // and highlighted state, not just the application's theme. Never replace it.
    if cfg!(target_os = "macos") {
        return;
    }
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let dark = panel_is_dark(app);
    if let Ok(mut previous) = state.dark.lock() {
        if *previous != dark {
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                if icon(dark)
                    .and_then(|image| tray.set_icon(Some(image)))
                    .is_ok()
                {
                    *previous = dark;
                }
            }
        }
    };
}

#[cfg(target_os = "linux")]
fn linux_tray_available() -> bool {
    use dbus::blocking::{stdintf::org_freedesktop_dbus::Properties, Connection};
    let Ok(connection) = Connection::new_session() else {
        return false;
    };
    let proxy = connection.with_proxy(
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        std::time::Duration::from_millis(500),
    );
    proxy
        .get::<bool>(
            "org.kde.StatusNotifierWatcher",
            "IsStatusNotifierHostRegistered",
        )
        .unwrap_or(false)
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)?;
    let hide_label = if cfg!(target_os = "macos") {
        "隐藏到菜单栏"
    } else {
        "隐藏到系统托盘"
    };
    let hide = MenuItem::with_id(app, "tray-hide", hide_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 PenguX11VNC", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;
    let dark = !cfg!(target_os = "macos") && panel_is_dark(app);
    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("PenguX11VNC")
        .icon(icon(dark)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        // Windows: left click restores; right click opens the menu.
        // macOS/Linux: click the status icon, then choose the menu action.
        .show_menu_on_left_click(!cfg!(target_os = "windows"))
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "tray-show" => restore_main(app),
                "tray-hide" => hide_main(app),
                "tray-quit" => {
                    shutdown(app);
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if result.is_err() {
                eprintln!("无法更新 PenguX11VNC 主窗口状态");
            }
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "windows")
                && matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                )
            {
                let _ = restore_main(tray.app_handle());
            }
        })
        .build(app)?;
    #[cfg(target_os = "linux")]
    let available = linux_tray_available();
    #[cfg(not(target_os = "linux"))]
    let available = true;
    let stopped = Arc::new(AtomicBool::new(false));
    app.manage(TrayState {
        available: AtomicBool::new(available),
        hidden: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
        stopped: Arc::clone(&stopped),
        dark: Mutex::new(dark),
    });
    #[cfg(not(target_os = "macos"))]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                #[cfg(target_os = "linux")]
                let available = linux_tray_available();
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let Some(state) = handle.try_state::<TrayState>() else {
                        return;
                    };
                    if state.stopped.load(Ordering::Acquire) {
                        return;
                    }
                    #[cfg(target_os = "linux")]
                    {
                        state.available.store(available, Ordering::Release);
                        if !available && state.hidden.load(Ordering::Acquire) {
                            // A missing panel must not strand an invisible app.
                            let _ = restore_main(&handle);
                        }
                    }
                    refresh_theme(&handle);
                });
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_close_hides_but_children_keep_native_close() {
        assert_eq!(decide_close("main", true, false), CloseAction::HideMain);
        assert_eq!(
            decide_close("qq-child-123", true, false),
            CloseAction::CloseChild
        );
        assert_eq!(decide_close("setup", true, false), CloseAction::Ignore);
    }

    #[test]
    fn quitting_or_missing_tray_never_traps_main_window() {
        assert_eq!(decide_close("main", true, true), CloseAction::ExitMain);
        assert_eq!(decide_close("main", false, false), CloseAction::ExitMain);
        assert_eq!(
            decide_close("qq-child-123", false, true),
            CloseAction::CloseChild
        );
    }

    #[test]
    fn tray_assets_are_only_black_white_and_alpha_with_identical_shape() {
        let black = icon(false).unwrap();
        let white = icon(true).unwrap();
        assert_eq!((black.width(), black.height()), (64, 64));
        assert_eq!(black.rgba().len(), white.rgba().len());
        let mut visible = 0;
        let mut transparent = 0;
        for (b, w) in black
            .rgba()
            .chunks_exact(4)
            .zip(white.rgba().chunks_exact(4))
        {
            assert_eq!(b[3], w[3]);
            if b[3] > 0 {
                assert_eq!(&b[..3], &[0, 0, 0]);
                assert_eq!(&w[..3], &[255, 255, 255]);
                visible += 1;
            } else {
                transparent += 1;
            }
        }
        assert!(visible > 100 && transparent > 1000);
    }

    #[test]
    fn kde_palette_detection_handles_light_dark_and_bad_input() {
        assert_eq!(
            kde_background_is_dark("[Colors:Window]\nBackgroundNormal=30,30,30\n"),
            Some(true)
        );
        assert_eq!(
            kde_background_is_dark("[Colors:Window]\nBackgroundNormal=239,240,241\n"),
            Some(false)
        );
        assert_eq!(
            kde_background_is_dark("[Colors:Button]\nBackgroundNormal=0,0,0"),
            None
        );
        assert_eq!(
            kde_background_is_dark("[Colors:Window]\nBackgroundNormal=invalid"),
            None
        );
    }
}
