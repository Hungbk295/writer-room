//! Terminal PTY Manager — ADR-1/ADR-2 (decision 0010).
//!
//! Rust sở hữu PTY, process lifecycle và ring buffer scrollback. Output đi qua
//! một Tauri `Channel` riêng cho mỗi session (không global emit, không
//! WebSocket), batch 16 ms / 32 KiB, kèm `sequence` tăng dần. UI reattach bằng
//! `terminal_attach` (swap channel + snapshot atomically).

pub mod ring;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use ring::RingBuffer;

const RING_CAPACITY: usize = 2 * 1024 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_MAX_BYTES: usize = 32 * 1024;

// ---------- DTO (khớp shared/src/terminal.ts) ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateRequest {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub turn_id: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub sequence: u64,
    /// base64 raw bytes — chunk boundary có thể cắt giữa UTF-8 sequence,
    /// xterm.js nhận Uint8Array và tự ghép.
    pub data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub session_id: String,
    pub pid: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub sequence: u64,
    /// base64 nội dung ring buffer
    pub data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSummary {
    pub session_id: String,
    pub pid: u32,
    pub executable: String,
    pub agent_id: Option<String>,
    pub read_only: bool,
    pub running: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<u32>,
    pub turn_id: Option<u64>,
}

// ---------- Session ----------

/// Sink nhận (sequence, bytes) — command layer bọc Tauri Channel, tests bọc Vec.
pub type Sink = Box<dyn Fn(u64, &[u8]) + Send + 'static>;

/// seq + ring + sink sau MỘT mutex — tránh lock-order inversion giữa
/// batcher (push rồi send) và attach (swap sink rồi snapshot).
struct OutputState {
    seq: u64,
    ring: RingBuffer,
    sink: Sink,
}

struct Session {
    id: String,
    pid: u32,
    executable: String,
    agent_id: Option<String>,
    read_only: bool,
    running: Arc<AtomicBool>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Arc<Mutex<OutputState>>,
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_id: AtomicU64,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1) }
    }

    /// Core create — không phụ thuộc Tauri, test được trực tiếp.
    pub fn create(
        &self,
        req: TerminalCreateRequest,
        sink: Sink,
        on_exit: Box<dyn FnOnce(Option<u32>) + Send + 'static>,
    ) -> Result<(String, u32), String> {
        // cwd rỗng → home dir (client không cần biết home path)
        let cwd = if req.cwd.is_empty() {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map_err(|_| "không tìm được home dir".to_string())?
        } else {
            req.cwd.clone()
        };
        if !std::path::Path::new(&cwd).is_dir() {
            return Err(format!("cwd không tồn tại: {cwd}"));
        }
        let pty = native_pty_system();
        let cols = if req.cols >= 40 { req.cols } else { 120 };
        let rows = if req.rows >= 10 { req.rows } else { 30 };
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {e}"))?;

        let mut cmd = CommandBuilder::new(&req.executable);
        cmd.args(&req.args);
        cmd.cwd(&cwd);
        for (k, v) in &req.env {
            // Never let a headless parent inject TERM=dumb into a TUI PTY —
            // Antigravity/Grok/Codex render blank in that case.
            if k == "TERM" && (v == "dumb" || v == "unknown" || v.is_empty()) {
                continue;
            }
            cmd.env(k, v);
        }
        let term = req
            .env
            .get("TERM")
            .filter(|v| *v != "dumb" && *v != "unknown" && !v.is_empty())
            .map(|s| s.as_str())
            .unwrap_or("xterm-256color");
        cmd.env("TERM", term);
        if !req.env.contains_key("COLORTERM") {
            cmd.env("COLORTERM", "truecolor");
        }
        if !req.env.contains_key("COLUMNS") {
            cmd.env("COLUMNS", cols.to_string());
        }
        if !req.env.contains_key("LINES") {
            cmd.env("LINES", rows.to_string());
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {e}"))?;
        drop(pair.slave);
        let pid = child.process_id().ok_or("no pid")?;
        let killer = child.clone_killer();

        let reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;

        let id = format!("term-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let running = Arc::new(AtomicBool::new(true));
        let output = Arc::new(Mutex::new(OutputState {
            seq: 0,
            ring: RingBuffer::new(RING_CAPACITY),
            sink,
        }));

        let session = Arc::new(Session {
            id: id.clone(),
            pid,
            executable: req.executable.clone(),
            agent_id: req.agent_id.clone(),
            read_only: req.read_only,
            running: Arc::clone(&running),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            output: Arc::clone(&output),
        });
        self.sessions.lock().unwrap().insert(id.clone(), session);

        spawn_reader_batcher(reader, output);

        // waiter: chờ child exit → cập nhật trạng thái + báo lên
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|st: portable_pty::ExitStatus| st.exit_code());
            running.store(false, Ordering::SeqCst);
            on_exit(code);
        });

        Ok((id, pid))
    }

    fn get(&self, session_id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("session không tồn tại: {session_id}"))
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let s = self.get(session_id)?;
        if s.read_only {
            return Err("session read-only — không nhận input".into());
        }
        use std::io::Write as _;
        let mut w = s.writer.lock().unwrap();
        w.write_all(data.as_bytes()).map_err(|e| format!("write: {e}"))?;
        w.flush().map_err(|e| format!("flush: {e}"))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols < 40 || rows < 10 {
            return Ok(());
        }
        let s = self.get(session_id)?;
        let result = s
            .master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize: {e}"));
        result
    }

    /// Kill cả process tree (Unix: process group — portable-pty setsid child
    /// nên pgid == pid; Windows: taskkill /T best-effort) rồi remove session.
    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let s = self.get(session_id)?;
        // An exited headless session is retained only for scrollback. Do not
        // signal its old PID: the OS may already have recycled that number.
        if s.running.load(Ordering::SeqCst) {
            kill_tree(s.pid);
            let _ = s.killer.lock().unwrap().kill();
        }
        self.sessions.lock().unwrap().remove(session_id);
        Ok(())
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }

    pub fn list(&self) -> Vec<TerminalSessionSummary> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| TerminalSessionSummary {
                session_id: s.id.clone(),
                pid: s.pid,
                executable: s.executable.clone(),
                agent_id: s.agent_id.clone(),
                read_only: s.read_only,
                running: s.running.load(Ordering::SeqCst),
            })
            .collect()
    }

    pub fn snapshot(&self, session_id: &str) -> Result<TerminalSnapshot, String> {
        let s = self.get(session_id)?;
        let out = s.output.lock().unwrap();
        Ok(TerminalSnapshot { sequence: out.seq, data: B64.encode(out.ring.contents()) })
    }

    /// Reattach: swap sink + snapshot dưới cùng một lock — mọi chunk sau
    /// snapshot chắc chắn đi vào channel mới với sequence lớn hơn.
    pub fn attach(&self, session_id: &str, sink: Sink) -> Result<TerminalSnapshot, String> {
        let s = self.get(session_id)?;
        let mut out = s.output.lock().unwrap();
        out.sink = sink;
        Ok(TerminalSnapshot { sequence: out.seq, data: B64.encode(out.ring.contents()) })
    }
}

/// Reader đọc PTY thành chunk thô; batcher gộp theo 16 ms / 32 KiB rồi flush
/// vào ring + sink với sequence tăng dần.
fn spawn_reader_batcher(mut reader: Box<dyn Read + Send>, output: Arc<Mutex<OutputState>>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut acc = first;
            let deadline = Instant::now() + FLUSH_INTERVAL;
            while acc.len() < FLUSH_MAX_BYTES {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(chunk) => acc.extend_from_slice(&chunk),
                    Err(_) => break,
                }
            }
            let mut out = output.lock().unwrap();
            out.seq += 1;
            let seq = out.seq;
            out.ring.push(&acc);
            (out.sink)(seq, &acc);
        }
    });
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    // portable-pty spawn child qua setsid → child là session/group leader
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
}

// ---------- Tauri commands ----------

pub mod commands {
    use super::*;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Emitter, State};

    fn channel_sink(ch: Channel<OutputChunk>) -> Sink {
        Box::new(move |seq, bytes| {
            let _ = ch.send(OutputChunk { sequence: seq, data: B64.encode(bytes) });
        })
    }

    #[tauri::command]
    pub fn terminal_create(
        app: AppHandle,
        state: State<'_, TerminalManager>,
        request: TerminalCreateRequest,
        on_output: Channel<OutputChunk>,
    ) -> Result<TerminalCreateResult, String> {
        // on_exit cần session_id nhưng id sinh trong create → dùng slot chia sẻ
        let id_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let id_for_exit = Arc::clone(&id_slot);
        let turn_id = request.turn_id;
        let (session_id, pid) = state.create(
            request,
            channel_sink(on_output),
            Box::new(move |code| {
                let sid = id_for_exit.lock().unwrap().clone().unwrap_or_default();
                let _ = app.emit(
                    "terminal://exit",
                    TerminalExitEvent { session_id: sid, exit_code: code, turn_id },
                );
            }),
        )?;
        *id_slot.lock().unwrap() = Some(session_id.clone());
        Ok(TerminalCreateResult { session_id, pid })
    }

    #[tauri::command]
    pub fn terminal_write(
        state: State<'_, TerminalManager>,
        session_id: String,
        data: String,
    ) -> Result<(), String> {
        state.write(&session_id, &data)
    }

    #[tauri::command]
    pub fn terminal_resize(
        state: State<'_, TerminalManager>,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        state.resize(&session_id, cols, rows)
    }

    #[tauri::command]
    pub fn terminal_kill(state: State<'_, TerminalManager>, session_id: String) -> Result<(), String> {
        state.kill(&session_id)
    }

    #[tauri::command]
    pub fn terminal_list(state: State<'_, TerminalManager>) -> Vec<TerminalSessionSummary> {
        state.list()
    }

    #[tauri::command]
    pub fn terminal_snapshot(
        state: State<'_, TerminalManager>,
        session_id: String,
    ) -> Result<TerminalSnapshot, String> {
        state.snapshot(&session_id)
    }

    #[tauri::command]
    pub fn terminal_attach(
        state: State<'_, TerminalManager>,
        session_id: String,
        on_output: Channel<OutputChunk>,
    ) -> Result<TerminalSnapshot, String> {
        state.attach(&session_id, channel_sink(on_output))
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn collecting_sink() -> (Sink, Arc<Mutex<Vec<u8>>>) {
        let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let b = Arc::clone(&buf);
        (Box::new(move |_seq, bytes| b.lock().unwrap().extend_from_slice(bytes)), buf)
    }

    fn shell_request(script: &str, read_only: bool) -> TerminalCreateRequest {
        #[cfg(unix)]
        let (executable, args) = ("/bin/sh".to_string(), vec!["-c".to_string(), script.to_string()]);
        #[cfg(windows)]
        let (executable, args) = ("cmd.exe".to_string(), vec!["/C".to_string(), script.to_string()]);
        TerminalCreateRequest {
            executable,
            args,
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            env: HashMap::new(),
            cols: 80,
            rows: 24,
            agent_id: None,
            read_only,
            turn_id: None,
        }
    }

    #[test]
    fn spawn_echo_collects_output_and_exit() {
        let mgr = TerminalManager::new();
        let (sink, buf) = collecting_sink();
        let (tx, rx) = mpsc::channel::<Option<u32>>();
        let (id, pid) = mgr
            .create(shell_request("echo hello-pty", false), sink, Box::new(move |c| {
                let _ = tx.send(c);
            }))
            .unwrap();
        assert!(pid > 0);
        let code = rx.recv_timeout(Duration::from_secs(10)).expect("exit trong 10s");
        assert_eq!(code, Some(0));
        // batcher flush async — chờ output tới
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = String::from_utf8_lossy(&buf.lock().unwrap().clone()).to_string();
            if text.contains("hello-pty") {
                break;
            }
            assert!(Instant::now() < deadline, "không thấy output: {text:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
        // list phản ánh trạng thái exited
        let deadline = Instant::now() + Duration::from_secs(5);
        while mgr.list().iter().any(|s| s.session_id == id && s.running) {
            assert!(Instant::now() < deadline, "running không về false");
            std::thread::sleep(Duration::from_millis(20));
        }
        // snapshot chứa output đã ghi vào ring
        let snap = mgr.snapshot(&id).unwrap();
        let bytes = B64.decode(snap.data).unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("hello-pty"));
        assert!(snap.sequence >= 1);
    }

    #[cfg(unix)]
    #[test]
    fn write_roundtrip_via_cat() {
        let mgr = TerminalManager::new();
        let (sink, buf) = collecting_sink();
        let (id, _) = mgr
            .create(shell_request("cat", false), sink, Box::new(|_| {}))
            .unwrap();
        mgr.write(&id, "ping\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = String::from_utf8_lossy(&buf.lock().unwrap().clone()).to_string();
            if text.contains("ping") {
                break;
            }
            assert!(Instant::now() < deadline, "không thấy echo từ cat: {text:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
        mgr.kill(&id).unwrap();
        assert!(mgr.list().iter().all(|s| s.session_id != id));
    }

    #[test]
    fn read_only_rejects_write() {
        let mgr = TerminalManager::new();
        let (sink, _) = collecting_sink();
        let (id, _) = mgr
            .create(shell_request("sleep 5", true), sink, Box::new(|_| {}))
            .unwrap();
        assert!(mgr.write(&id, "x").is_err());
        mgr.kill(&id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn kill_terminates_process_tree() {
        let mgr = TerminalManager::new();
        let (sink, _) = collecting_sink();
        let (tx, rx) = mpsc::channel::<Option<u32>>();
        // sh spawn sleep con → kill phải diệt cả hai (process group)
        let (id, pid) = mgr
            .create(shell_request("sleep 300", false), sink, Box::new(move |c| {
                let _ = tx.send(c);
            }))
            .unwrap();
        mgr.kill(&id).unwrap();
        rx.recv_timeout(Duration::from_secs(10)).expect("child exit sau kill");
        // group leader không còn sống
        let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
        assert!(!alive, "pid {pid} vẫn sống sau kill");
    }

    #[test]
    fn invalid_cwd_rejected() {
        let mgr = TerminalManager::new();
        let (sink, _) = collecting_sink();
        let mut req = shell_request("echo x", false);
        req.cwd = "/nonexistent-dir-writer-room-test".into();
        assert!(mgr.create(req, sink, Box::new(|_| {})).is_err());
    }
}
