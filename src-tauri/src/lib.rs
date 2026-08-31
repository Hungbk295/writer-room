//! Spy desktop shell + Terminal PTY Manager (decision 0010).
//!
//! The window is a view onto the daemon. Closing the window does not kill the
//! daemon — harvest jobs can outlive the UI. Terminal PTYs are owned by Rust.

mod terminal;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 4187;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

fn port() -> u16 {
    std::env::var("WRITER_ROOM_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn base_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

fn ui_url() -> String {
    if let Ok(url) = std::env::var("WRITER_ROOM_UI_URL") {
        return url;
    }
    if cfg!(debug_assertions) {
        let dev_port = std::env::var("WRITER_ROOM_DEV_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5178);
        return format!("http://127.0.0.1:{dev_port}");
    }
    base_url()
}

fn daemon_is_up() -> bool {
    // Do not shell out to curl: a Windows installer must be self-contained.
    let addr = SocketAddr::from(([127, 0, 0, 1], port()));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 128];
    matches!(stream.read(&mut response), Ok(size) if String::from_utf8_lossy(&response[..size]).starts_with("HTTP/1.1 200"))
}

fn app_root(handle: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("WRITER_ROOM_ROOT") {
        return Some(std::path::PathBuf::from(explicit));
    }
    if let Ok(resource) = handle.path().resource_dir() {
        let bundled = resource.join("app");
        if bundled.join("packages/daemon/src/index.ts").exists() {
            return Some(bundled);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    dev.join("packages/daemon/src/index.ts")
        .exists()
        .then(|| dev.to_path_buf())
}

/// Files delivered inside the signed application bundle.  This location is
/// deliberately separate from `app_data_dir`: it is immutable program code,
/// whereas Spy evidence and SQLite databases are per-user state.
fn bundled_resource_dir(handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    handle
        .path()
        .resource_dir()
        .map(|dir| dir.join("resources"))
        .map_err(|error| format!("không tìm thấy tài nguyên ứng dụng: {error}"))
}

fn user_data_dir(handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("không xác định được thư mục dữ liệu: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("không tạo được thư mục dữ liệu {}: {error}", dir.display()))?;
    Ok(dir)
}

fn bun_binary() -> String {
    std::env::var("WRITER_ROOM_BUN_BIN").unwrap_or_else(|_| {
        for candidate in [
            "~/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ] {
            let expanded = shellexpand(candidate);
            if std::path::Path::new(&expanded).exists() {
                return expanded;
            }
        }
        "bun".to_string()
    })
}

fn shellexpand(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => match std::env::var("HOME") {
            Ok(home) => format!("{home}/{rest}"),
            Err(_) => path.to_string(),
        },
        None => path.to_string(),
    }
}

fn spawn_daemon(root: &std::path::Path) -> Result<(), String> {
    Command::new(bun_binary())
        .arg("packages/daemon/src/index.ts")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("không chạy được daemon: {error}"))
}

fn bundled_daemon_name() -> &'static str {
    if cfg!(windows) {
        "writer-room-daemon.exe"
    } else {
        "writer-room-daemon"
    }
}

/// Start the production daemon without depending on Bun or the source tree on
/// the recipient's computer. `prepare-desktop-bundle.ts` creates these files
/// before Tauri builds the installer.
fn spawn_bundled_daemon(handle: &tauri::AppHandle) -> Result<(), String> {
    let resources = bundled_resource_dir(handle)?;
    let daemon = resources.join("bin").join(bundled_daemon_name());
    let web_root = resources.join("web");
    let data_root = user_data_dir(handle)?;

    if !daemon.is_file() {
        return Err(format!("thiếu daemon đã đóng gói: {}", daemon.display()));
    }
    if !web_root.join("index.html").is_file() {
        return Err(format!("thiếu UI đã đóng gói: {}", web_root.display()));
    }

    Command::new(&daemon)
        .current_dir(&data_root)
        .env("WRITER_ROOM_DATA_DIR", &data_root)
        .env("WRITER_ROOM_WEB_ROOT", &web_root)
        .env(
            "WRITER_ROOM_YTDLP_BIN",
            resources.join("bin").join(if cfg!(windows) {
                "yt-dlp.exe"
            } else {
                "yt-dlp"
            }),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("không chạy được daemon đã đóng gói: {error}"))
}

fn wait_for_daemon() -> bool {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if daemon_is_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    false
}

fn failure_page(detail: &str) -> String {
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>Spy</title>
<body style="font-family:system-ui;padding:2.5rem;line-height:1.6;color:#12161c;background:#eef2f6">
<h1 style="font-family:Georgia,serif">Không kết nối được engine</h1>
<p>{detail}</p>
<p>Chạy tay trong thư mục dự án:</p>
<pre style="background:#0d1117;color:#e6edf3;padding:1rem;border-radius:10px">bun packages/daemon/src/index.ts</pre>
<p style="color:#2a3140">Rồi mở lại app. Nếu daemon đang chạy ở cổng khác, đặt <code>WRITER_ROOM_PORT</code>.</p>
</body>"#
    )
}

pub fn run() {
    tauri::Builder::default()
        .manage(terminal::TerminalManager::new())
        .invoke_handler(tauri::generate_handler![
            terminal::commands::terminal_create,
            terminal::commands::terminal_write,
            terminal::commands::terminal_resize,
            terminal::commands::terminal_kill,
            terminal::commands::terminal_list,
            terminal::commands::terminal_snapshot,
            terminal::commands::terminal_attach,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let status = if daemon_is_up() {
                Ok(())
            } else {
                if cfg!(debug_assertions) {
                    match app_root(&handle) {
                        Some(root) => spawn_daemon(&root).and_then(|()| {
                            if wait_for_daemon() {
                                Ok(())
                            } else {
                                Err(format!(
                                    "daemon không phản hồi sau {}s",
                                    STARTUP_TIMEOUT.as_secs()
                                ))
                            }
                        }),
                        None => Err("không tìm thấy mã nguồn daemon".to_string()),
                    }
                } else {
                    spawn_bundled_daemon(&handle).and_then(|()| {
                        if wait_for_daemon() {
                            Ok(())
                        } else {
                            Err(format!(
                                "daemon không phản hồi sau {}s",
                                STARTUP_TIMEOUT.as_secs()
                            ))
                        }
                    })
                }
            };

            let url = match &status {
                Ok(()) => WebviewUrl::External(ui_url().parse().expect("valid ui url")),
                Err(detail) => {
                    let encoded = urlencode(&failure_page(detail));
                    WebviewUrl::External(
                        format!("data:text/html;charset=utf-8,{encoded}")
                            .parse()
                            .expect("valid data url"),
                    )
                }
            };

            WebviewWindowBuilder::new(&handle, "main", url)
                .title("Spy")
                .inner_size(1440.0, 920.0)
                .min_inner_size(520.0, 420.0)
                .center()
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Spy");
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}
