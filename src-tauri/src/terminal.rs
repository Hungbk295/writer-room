#[cfg(not(windows))]
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
fn desktop_path() -> std::ffi::OsString {
    let mut entries = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        entries.push(std::path::PathBuf::from(home).join(".local").join("bin"));
    }
    entries.push(std::path::PathBuf::from("/opt/homebrew/bin"));
    entries.push(std::path::PathBuf::from("/usr/local/bin"));
    if let Some(current) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&current));
    }
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

#[derive(Clone)]
pub struct TerminalManager {
    jobs: Arc<Mutex<HashMap<String, ManagedJob>>>,
}

struct ManagedJob {
    pid: u32,
    #[cfg(not(windows))]
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn run(
        &self,
        app: AppHandle,
        runner: &Path,
        session: &str,
        role: &str,
        cwd: &str,
        descriptor_path: &str,
    ) -> Result<(), String> {
        if !Path::new(cwd).is_dir() {
            return Err(format!("terminal cwd does not exist: {cwd}"));
        }
        let key = format!("{session}:{role}");
        if let Some(mut old) = self.jobs.lock().unwrap().remove(&key) {
            kill_tree(old.pid);
            #[cfg(not(windows))]
            let _ = old.killer.kill();
        }

        #[cfg(windows)]
        return self.run_piped_windows(app, runner, session, role, cwd, descriptor_path, key);

        #[cfg(not(windows))]
        self.run_pty(app, runner, session, role, cwd, descriptor_path, key)
    }

    #[cfg(not(windows))]
    fn run_pty(
        &self,
        app: AppHandle,
        runner: &Path,
        session: &str,
        role: &str,
        cwd: &str,
        descriptor_path: &str,
        key: String,
    ) -> Result<(), String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 32,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("open PTY/ConPTY: {error}"))?;
        let mut command = CommandBuilder::new(runner);
        command.arg(descriptor_path);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("NO_COLOR", "1");
        command.env("FORCE_COLOR", "0");
        #[cfg(target_os = "macos")]
        command.env("PATH", desktop_path());
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn runner: {error}"))?;
        drop(pair.slave);
        let pid = child.process_id().ok_or("runner PID unavailable")?;
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("clone PTY reader: {error}"))?;
        self.jobs
            .lock()
            .unwrap()
            .insert(key.clone(), ManagedJob { pid, killer });

        let (output_sender, output_receiver) = mpsc::channel::<Vec<u8>>();
        let exit_session = session.to_owned();
        let exit_role = role.to_owned();
        let exit_descriptor = descriptor_path.to_owned();
        std::thread::spawn(move || {
            let mut bytes = [0_u8; 8192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if output_sender.send(bytes[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let read_app = app.clone();
        let read_session = session.to_owned();
        let read_role = role.to_owned();
        std::thread::spawn(move || {
            while let Ok(first) = output_receiver.recv() {
                let mut batch = first;
                let deadline = Instant::now() + Duration::from_millis(16);
                while batch.len() < 32 * 1024 {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match output_receiver.recv_timeout(deadline - now) {
                        Ok(chunk) => batch.extend_from_slice(&chunk),
                        Err(_) => break,
                    }
                }
                let chunk = String::from_utf8_lossy(&batch).to_string();
                let _ = read_app.emit(
                    "writer-room://terminal-output",
                    json!({
                        "session": read_session,
                        "role": read_role,
                        "chunk": chunk,
                    }),
                );
            }
        });

        let jobs = Arc::clone(&self.jobs);
        std::thread::spawn(move || {
            let exit_code = child.wait().ok().map(|status| status.exit_code());
            settle_missing_result(&exit_descriptor, exit_code);
            let mut values = jobs.lock().unwrap();
            if values.get(&key).map(|job| job.pid) == Some(pid) {
                values.remove(&key);
            }
            drop(values);
            let _ = app.emit(
                "writer-room://terminal-exit",
                json!({
                    "session": exit_session,
                    "role": exit_role,
                    "pid": pid,
                    "exitCode": exit_code,
                }),
            );
        });
        Ok(())
    }

    #[cfg(windows)]
    fn run_piped_windows(
        &self,
        app: AppHandle,
        runner: &Path,
        session: &str,
        role: &str,
        cwd: &str,
        descriptor_path: &str,
        key: String,
    ) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};

        // Writer Room agents are print-mode processes. Launching the Bun runner
        // through ConPTY can fail before main() with STATUS_DLL_INIT_FAILED
        // (0xC0000142), leaving no result envelope. Direct pipes preserve all
        // output and process-tree cancellation without requiring an interactive
        // console host.
        let mut child = Command::new(runner)
            .arg(descriptor_path)
            .current_dir(cwd)
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|error| format!("spawn Windows runner without ConPTY: {error}"))?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("runner stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("runner stderr unavailable")?;
        self.jobs
            .lock()
            .unwrap()
            .insert(key.clone(), ManagedJob { pid });

        let (output_sender, output_receiver) = mpsc::channel::<Vec<u8>>();
        for mut reader in [Box::new(stdout) as Box<dyn Read + Send>, Box::new(stderr)] {
            let sender = output_sender.clone();
            std::thread::spawn(move || {
                let mut bytes = [0_u8; 8192];
                loop {
                    match reader.read(&mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            if sender.send(bytes[..count].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
        drop(output_sender);

        let read_app = app.clone();
        let read_session = session.to_owned();
        let read_role = role.to_owned();
        std::thread::spawn(move || {
            while let Ok(first) = output_receiver.recv() {
                let mut batch = first;
                let deadline = Instant::now() + Duration::from_millis(16);
                while batch.len() < 32 * 1024 {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match output_receiver.recv_timeout(deadline - now) {
                        Ok(chunk) => batch.extend_from_slice(&chunk),
                        Err(_) => break,
                    }
                }
                let chunk = String::from_utf8_lossy(&batch).to_string();
                let _ = read_app.emit(
                    "writer-room://terminal-output",
                    json!({
                        "session": read_session,
                        "role": read_role,
                        "chunk": chunk,
                    }),
                );
            }
        });

        let jobs = Arc::clone(&self.jobs);
        let exit_session = session.to_owned();
        let exit_role = role.to_owned();
        let exit_descriptor = descriptor_path.to_owned();
        std::thread::spawn(move || {
            let exit_code = child
                .wait()
                .ok()
                .and_then(|status| status.code())
                .map(|code| code as u32);
            settle_missing_result(&exit_descriptor, exit_code);
            let mut values = jobs.lock().unwrap();
            if values.get(&key).map(|job| job.pid) == Some(pid) {
                values.remove(&key);
            }
            drop(values);
            let _ = app.emit(
                "writer-room://terminal-exit",
                json!({
                    "session": exit_session,
                    "role": exit_role,
                    "pid": pid,
                    "exitCode": exit_code,
                }),
            );
        });
        Ok(())
    }

    pub fn kill_session(&self, session: &str) {
        let prefix = format!("{session}:");
        let keys: Vec<String> = self
            .jobs
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        for key in keys {
            if let Some(mut job) = self.jobs.lock().unwrap().remove(&key) {
                kill_tree(job.pid);
                #[cfg(not(windows))]
                let _ = job.killer.kill();
            }
        }
    }

    pub fn kill_all(&self) {
        let keys: Vec<String> = self.jobs.lock().unwrap().keys().cloned().collect();
        for key in keys {
            if let Some(mut job) = self.jobs.lock().unwrap().remove(&key) {
                kill_tree(job.pid);
                #[cfg(not(windows))]
                let _ = job.killer.kill();
            }
        }
    }
}

pub fn settle_missing_result(descriptor_path: &str, exit_code: Option<u32>) {
    let Ok(content) = std::fs::read_to_string(descriptor_path) else {
        return;
    };
    let Ok(descriptor) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let Some(result_path) = descriptor
        .get("resultPath")
        .and_then(serde_json::Value::as_str)
    else {
        return;
    };
    if Path::new(result_path).is_file() {
        return;
    }
    let message = runner_exit_message(exit_code);
    let timestamp = format!(
        "unix:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default()
    );
    let envelope = json!({
        "schemaVersion": descriptor.get("schemaVersion").cloned().unwrap_or_else(|| json!(2)),
        "id": descriptor.get("id").cloned().unwrap_or_else(|| json!("native-runner")),
        "adapter": descriptor.get("adapter").cloned().unwrap_or_else(|| json!("unknown")),
        "startedAt": timestamp,
        "finishedAt": timestamp,
        "exitCode": exit_code.map(|value| value as i64).unwrap_or(-1),
        "timedOut": false,
        "stdout": "",
        "stderr": message,
        "error": message,
    });
    let temporary = format!("{result_path}.native.{}.tmp", std::process::id());
    if std::fs::write(&temporary, format!("{envelope}\n")).is_ok() {
        let _ = std::fs::rename(temporary, result_path);
    }
}

fn runner_exit_message(exit_code: Option<u32>) -> String {
    if exit_code == Some(0xC000_0142) {
        return "Windows native runner failed to initialize (exit=3221225794, 0xC0000142 STATUS_DLL_INIT_FAILED). Install the updated Writer Room build that launches print-mode agents without ConPTY; if it persists, repair the Windows runtime and reboot.".to_owned();
    }
    format!(
        "native runner exited before producing a result envelope (exit={})",
        exit_code
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_owned())
    )
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    let mut targets = descendant_pids(pid);
    targets.push(pid);
    for target in &targets {
        unsafe {
            libc::kill(*target as i32, libc::SIGTERM);
        }
    }
    std::thread::sleep(Duration::from_millis(150));
    for target in &targets {
        unsafe {
            if libc::kill(*target as i32, 0) == 0 {
                libc::kill(*target as i32, libc::SIGKILL);
            }
        }
    }
}

#[cfg(unix)]
fn descendant_pids(root: u32) -> Vec<u32> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    else {
        return Vec::new();
    };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (fields.next(), fields.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
    }
    fn collect(parent: u32, children: &HashMap<u32, Vec<u32>>, result: &mut Vec<u32>) {
        for child in children.get(&parent).into_iter().flatten() {
            collect(*child, children, result);
            result.push(*child);
        }
    }
    let mut result = Vec::new();
    collect(root, &children, &mut result);
    result
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000)
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_failure_is_settled_as_a_result_envelope() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("writer-room-terminal-{unique}"));
        std::fs::create_dir_all(&directory).unwrap();
        let result = directory.join("result.json");
        let descriptor = directory.join("job.json");
        std::fs::write(
            &descriptor,
            json!({
                "schemaVersion": 2,
                "id": "native-failure-test",
                "adapter": "mock",
                "resultPath": result,
            })
            .to_string(),
        )
        .unwrap();
        settle_missing_result(descriptor.to_str().unwrap(), Some(17));
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&result).unwrap()).unwrap();
        assert_eq!(value["exitCode"], 17);
        assert!(value["error"]
            .as_str()
            .unwrap()
            .contains("before producing"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn windows_dll_init_failure_has_actionable_diagnostic() {
        let message = runner_exit_message(Some(0xC000_0142));
        assert!(message.contains("STATUS_DLL_INIT_FAILED"));
        assert!(message.contains("without ConPTY"));
    }

    #[cfg(unix)]
    #[test]
    fn kill_tree_stops_runner_and_provider_descendants() {
        let mut runner = std::process::Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let descendants = descendant_pids(runner.id());
        assert!(!descendants.is_empty());
        kill_tree(runner.id());
        let _ = runner.wait();
        for pid in descendants {
            let alive = unsafe { libc::kill(pid as i32, 0) == 0 };
            assert!(!alive, "descendant {pid} survived cancellation");
        }
    }
}
