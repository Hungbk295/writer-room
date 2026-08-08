import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import { parseRoute, type Route } from './router.ts';
import { Home, TopNav } from './pages/Home.tsx';
import { SpyPage } from './pages/Spy.tsx';
import { SpyRunPage } from './pages/SpyRun.tsx';
import { WriterPage, WriterPackPage } from './pages/Writer.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { api } from './api.ts';

function App() {
  const [route, setRoute] = useState<Route>(parseRoute());
  const [health, setHealth] = useState<string>('…');
  const [writerCount, setWriterCount] = useState(0);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    void api.health()
      .then((h) => setHealth(h.ok ? (h.spy ? 'daemon · spy on' : 'daemon · spy off') : 'offline'))
      .catch(() => setHealth('offline'));
    void api.listWriterPacks()
      .then((d) => setWriterCount(d.packs.length))
      .catch(() => undefined);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (route.name === 'writer' || route.name === 'writer-pack') {
      void api.listWriterPacks()
        .then((d) => setWriterCount(d.packs.length))
        .catch(() => undefined);
    }
  }, [route]);

  let page;
  switch (route.name) {
    case 'spy':
      page = <SpyPage />;
      break;
    case 'spy-run':
      page = <SpyRunPage id={route.id} />;
      break;
    case 'writer':
      page = <WriterPage />;
      break;
    case 'writer-pack':
      page = <WriterPackPage id={route.id} />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    default:
      page = <Home />;
  }

  return (
    <div class="app-shell">
      <TopNav route={route} writerCount={writerCount} />
      <main class="main">
        {page}
        <p class="muted" style={{ marginTop: '2rem' }}>{health}</p>
      </main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
