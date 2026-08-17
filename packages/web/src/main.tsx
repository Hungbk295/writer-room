import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import { parseRoute, type Route } from './router.ts';
import { Home, TopNav } from './pages/Home.tsx';
import { SpyPage } from './pages/Spy.tsx';
import { SpyRunPage } from './pages/SpyRun.tsx';
import { WriterPage, WriterPackPage, WriterRunPage } from './pages/Writer.tsx';
import { WriterV2Page, WriterV2RunPage } from './pages/WriterV2.tsx';
import { FormulasPage, FormulaPage } from './pages/Training.tsx';
import { TrainingLabPage, TrainingLabRunPage } from './pages/TrainingLab.tsx';
import { StudioListPage, StudioSessionPage } from './pages/Studio.tsx';
import { StudioProfilePage, StudioProfilesPage } from './pages/StudioProfiles.tsx';
import { AgentsPage } from './pages/Agents.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { TerminalDrawer } from './components/terminal/TerminalDrawer.tsx';
import { TurnBridge } from './features/turn-bridge/TurnBridge.tsx';
import { getTerminalState, subscribeTerminals } from './components/terminal/terminalStore.ts';
import { api } from './api.ts';

function App() {
  const [route, setRoute] = useState<Route>(parseRoute());
  const [health, setHealth] = useState<string>('…');
  const [writerCount, setWriterCount] = useState(0);
  const [termTick, setTermTick] = useState(0);

  useEffect(() => subscribeTerminals(() => setTermTick((n) => n + 1)), []);

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
    if (route.name === 'writer' || route.name === 'writer-pack' || route.name === 'writer-run') {
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
    case 'writer-run':
      page = <WriterRunPage id={route.id} />;
      break;
    case 'writer-v2':
      page = <WriterV2Page />;
      break;
    case 'writer-v2-run':
      page = <WriterV2RunPage id={route.id} />;
      break;
    case 'training-formulas':
      page = <FormulasPage />;
      break;
    case 'training-formula':
      page = <FormulaPage id={route.id} />;
      break;
    case 'training-lab':
      page = <TrainingLabPage />;
      break;
    case 'training-lab-run':
      page = <TrainingLabRunPage id={route.id} />;
      break;
    case 'studio':
      page = <StudioListPage />;
      break;
    case 'studio-session':
      page = <StudioSessionPage id={route.id} />;
      break;
    case 'studio-profiles':
      page = <StudioProfilesPage />;
      break;
    case 'studio-profile':
      page = <StudioProfilePage id={route.id} />;
      break;
    case 'agents':
      page = <AgentsPage />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    default:
      page = <Home />;
  }

  // dna-spy: content height = 100vh - term height so drawer never covers scroll area.
  void termTick;
  const term = getTerminalState();
  const termHeightPx = term.open ? `${term.height}px` : '0px';

  return (
    <div
      class="app-shell"
      style={{ '--term-height': termHeightPx } as Record<string, string>}
    >
      <TopNav route={route} writerCount={writerCount} />
      <main class="main">
        {page}
        <p class="muted" style={{ marginTop: '2rem' }}>{health}</p>
      </main>
      <TerminalDrawer />
      <TurnBridge />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
