import type { Route } from '../router.ts';
import { href } from '../router.ts';
import { TerminalToggleButton } from '../components/terminal/TerminalDrawer.tsx';
import { JobNotificationCenter } from '../components/JobNotificationCenter.tsx';

export function Home() {
  return (
    <section class="hero">
      <h1>Spy</h1>
      <p>
        Thu hoạch kênh YouTube, lấy transcript và Source Pack —
        workspace local cho research.
      </p>
      <div class="destinations">
        <a class="destination" href={href({ name: 'spy' })}>
          <div class="eyebrow">Kênh</div>
          <h2>Spy</h2>
          <p>Thu hoạch kênh, xếp velocity, lấy transcript và xem bằng chứng.</p>
        </a>
        <a class="destination" href={href({ name: 'spy-loop' })}>
          <div class="eyebrow">Auto-Loop</div>
          <h2>Spy Loop</h2>
          <p>Tìm kênh đối thủ tự động theo chủ đề — duyệt Inbox hàng ngày.</p>
        </a>
        <a class="destination" href={href({ name: 'writer' })}>
          <div class="eyebrow">Staging</div>
          <h2>Writer</h2>
          <p>Source Pack đã chọn — xem, copy, tải markdown.</p>
        </a>
        <a class="destination" href={href({ name: 'agents' })}>
          <div class="eyebrow">Harness</div>
          <h2>Agents</h2>
          <p>Claude, Codex, Agy, Grok — team MCP, assign, readiness.</p>
        </a>
        <a class="destination" href={href({ name: 'settings' })}>
          <div class="eyebrow">Cấu hình</div>
          <h2>Settings</h2>
          <p>YouTube API key, concurrency, đường dẫn data.</p>
        </a>
      </div>
    </section>
  );
}

export function TopNav({ route, writerCount = 0 }: { route: Route; writerCount?: number }) {
  const is = (names: Route['name'][]) => (names.includes(route.name) ? 'active' : '');

  return (
    <header class="topbar">
      <a class="brand" href={href({ name: 'home' })}>
        Spy
      </a>
      <nav class="nav" aria-label="Điều hướng chính">
        <a class={is(['home'])} href={href({ name: 'home' })}>Home</a>
        <a class={is(['spy', 'spy-run', 'spy-channels', 'spy-channel'])} href={href({ name: 'spy' })}>Spy</a>
        <a class={is(['spy-loop'])} href={href({ name: 'spy-loop' })}>Loop</a>
        <a class={is(['writer', 'writer-pack'])} href={href({ name: 'writer' })}>
          Source Packs
          {writerCount > 0 && <span class="nav-badge">{writerCount}</span>}
        </a>
        <a class={is(['writer-v2', 'writer-v2-run'])} href={href({ name: 'writer-v2' })}>
          Writer
        </a>
        <a class={is(['channel-styles'])} href={href({ name: 'channel-styles' })}>
          Style kênh
        </a>
        <a
          class={is([
            'studio',
            'studio-session',
            'studio-profiles',
            'studio-profile',
            'training-formulas',
            'training-formula',
            'training-lab',
            'training-lab-run',
          ])}
          href={href({ name: 'studio' })}
        >
          Studio
        </a>
        <a class={is(['agents'])} href={href({ name: 'agents' })}>Agents</a>
        <a class={is(['settings'])} href={href({ name: 'settings' })}>Settings</a>
        <JobNotificationCenter />
        {/* Always-visible show/hide — same role as dna-spy sidebar "🖥 Terminal" */}
        <TerminalToggleButton />
        <span class="font-shortcut" title="Ctrl/Cmd + hoặc − để đổi cỡ chữ; Ctrl/Cmd 0 để đặt lại">
          Ctrl ±
        </span>
      </nav>
    </header>
  );
}
