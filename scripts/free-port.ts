/**
 * Utility to release a given TCP port if an orphaned process is holding it.
 */
import { execSync } from 'node:child_process';

const port = process.argv[2] || '5178';

try {
  const output = execSync(`lsof -ti:${port}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  if (output) {
    const pids = output.split('\n').map((s) => parseInt(s.trim(), 10)).filter((p) => Boolean(p) && p !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`[free-port] Đã giải phóng port ${port} (PID ${pid})`);
      } catch {}
    }
  }
} catch {
  // Port is not in use - nothing to kill
}
