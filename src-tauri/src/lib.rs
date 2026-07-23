mod terminal;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
fn desktop_path() -> std::ffi::OsString {
    let mut entries = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        entries.push(PathBuf::from(home).join(".local").join("bin"));
    }
    entries.push(PathBuf::from("/opt/homebrew/bin"));
    entries.push(PathBuf::from("/usr/local/bin"));
    if let Some(current) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&current));
    }
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

struct EngineBridge {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    next_id: AtomicU64,
}

impl EngineBridge {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

fn platform_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

fn binary_path(name: &str) -> Result<PathBuf, String> {
    let release_name = platform_name(name);
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            let candidate = directory.join(&release_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source_name = if cfg!(windows) {
        format!("{name}-{}.exe", env!("WRITER_ROOM_TARGET_TRIPLE"))
    } else {
        format!("{name}-{}", env!("WRITER_ROOM_TARGET_TRIPLE"))
    };
    let candidate = manifest
        .parent()
        .ok_or("writer-room root not found")?
        .join("binaries")
        .join(source_name);
    if candidate.is_file() {
        Ok(candidate)
    } else {
        Err(format!("missing sidecar: {}", candidate.display()))
    }
}

fn spawn_engine(
    app: &AppHandle,
    state: &EngineBridge,
    terminals: terminal::TerminalManager,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir: {error}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|error| format!("create app data: {error}"))?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resource dir: {error}"))?;
    let guide = resources
        .join("default-prompts")
        .join("kich ban youtube.txt");
    let criteria = resources
        .join("default-prompts")
        .join("các tiêu chí kịch bản.txt");
    let runner = binary_path("writer-room-runner")?;
    let mut command = Command::new(binary_path("writer-room-engine")?);
    command
        .env("WRITER_ROOM_DATA_DIR", &data_dir)
        .env("WRITER_ROOM_DEFAULT_GUIDE", &guide)
        .env("WRITER_ROOM_DEFAULT_CRITERIA", &criteria)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "macos")]
    command.env("PATH", desktop_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn Writer Room engine: {error}"))?;
    let stdin = child.stdin.take().ok_or("engine stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("engine stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("engine stderr unavailable")?;
    *state.stdin.lock().unwrap() = Some(stdin);

    let pending = Arc::clone(&state.pending);
    let output_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                eprintln!("[writer-room engine protocol] {line}");
                continue;
            };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Some(sender) = pending.lock().unwrap().remove(&id) {
                    let _ = sender.send(message);
                }
                continue;
            }
            let event = message
                .get("event")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let payload = message.get("payload").cloned().unwrap_or(Value::Null);
            if event == "terminal.run" {
                let session = payload
                    .get("session")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let descriptor = payload
                    .get("descriptorPath")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Err(error) =
                    terminals.run(output_app.clone(), &runner, session, role, cwd, descriptor)
                {
                    terminal::settle_missing_result(descriptor, None);
                    let _ = output_app.emit(
                        "writer-room://engine-error",
                        json!({ "message": error, "event": event }),
                    );
                }
            } else if event == "terminal.kill" {
                if let Some(session) = payload.get("session").and_then(Value::as_str) {
                    terminals.kill_session(session);
                }
            }
            let _ = output_app.emit("writer-room://engine-event", message);
        }
        pending.lock().unwrap().clear();
        let _ = output_app.emit("writer-room://engine-died", json!({}));
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[writer-room engine] {line}");
        }
    });
    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

#[tauri::command]
async fn writer_room_call(
    state: State<'_, EngineBridge>,
    method: String,
    params: Option<Value>,
) -> Result<Value, Value> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = mpsc::channel();
    state.pending.lock().unwrap().insert(id, sender);
    {
        let mut guard = state.stdin.lock().unwrap();
        let Some(stdin) = guard.as_mut() else {
            state.pending.lock().unwrap().remove(&id);
            return Err(
                json!({ "message": "Writer Room engine chưa chạy; hãy khởi động lại app." }),
            );
        };
        let request =
            json!({ "id": id, "method": method, "params": params.unwrap_or_else(|| json!({})) });
        if let Err(error) = writeln!(stdin, "{request}") {
            state.pending.lock().unwrap().remove(&id);
            return Err(json!({ "message": format!("engine write: {error}") }));
        }
    }
    let response = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(60))
    })
    .await
    .map_err(|error| json!({ "message": error.to_string() }))?
    .map_err(|_| json!({ "message": "Writer Room engine timeout/closed" }))?;
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(response
            .get("error")
            .cloned()
            .unwrap_or_else(|| json!({ "message": "engine error" })));
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EngineBridge::new())
        .manage(terminal::TerminalManager::new())
        .setup(|app| {
            let handle = app.handle().clone();
            let bridge: State<EngineBridge> = app.state();
            let terminals: State<terminal::TerminalManager> = app.state();
            if let Err(error) = spawn_engine(&handle, &bridge, terminals.inner().clone()) {
                eprintln!("[writer-room] {error}");
                let _ = handle.emit("writer-room://engine-died", json!({ "message": error }));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let terminals: State<terminal::TerminalManager> = window.app_handle().state();
                terminals.kill_all();
                let bridge: State<EngineBridge> = window.app_handle().state();
                let child = bridge.child.lock().unwrap().take();
                if let Some(mut child) = child {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![writer_room_call])
        .run(tauri::generate_context!())
        .expect("Writer Room failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_target_triple_sidecars_for_native_builds() {
        assert!(binary_path("writer-room-engine").unwrap().is_file());
        assert!(binary_path("writer-room-runner").unwrap().is_file());
    }

    #[test]
    fn release_binary_name_matches_platform() {
        let value = platform_name("writer-room-engine");
        if cfg!(windows) {
            assert!(value.ends_with(".exe"));
        } else {
            assert_eq!(value, "writer-room-engine");
        }
    }
}
