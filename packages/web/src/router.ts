export type Route =
  | { name: 'home' }
  | { name: 'spy' }
  | { name: 'spy-run'; id: string }
  | { name: 'writer' }
  | { name: 'writer-pack'; id: string }
  | { name: 'writer-run'; id: string }
  | { name: 'writer-v2' }
  | { name: 'writer-v2-run'; id: string }
  // `path` is a channel-style file name; absent means "no style opened yet"
  | { name: 'channel-styles'; path?: string }
  | { name: 'training-formulas' }
  | { name: 'training-formula'; id: string }
  | { name: 'training-lab' }
  | { name: 'training-lab-run'; id: string }
  | { name: 'studio' }
  | { name: 'studio-session'; id: string }
  | { name: 'studio-profiles' }
  | { name: 'studio-profile'; id: string }
  | { name: 'agents' }
  | { name: 'settings' };

export function parseRoute(hash = location.hash): Route {
  const path = hash.replace(/^#\/?/, '') || '';
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'spy' && parts[1]) return { name: 'spy-run', id: parts[1]! };
  if (parts[0] === 'spy') return { name: 'spy' };
  // Writer runs before packs so /writer/runs/:id does not look like a pack id
  if (parts[0] === 'writer' && parts[1] === 'runs' && parts[2]) {
    return { name: 'writer-run', id: parts[2]! };
  }
  if (parts[0] === 'writer' && parts[1] === 'v2' && parts[2]) {
    return { name: 'writer-v2-run', id: parts[2]! };
  }
  if (parts[0] === 'writer' && parts[1] === 'v2') return { name: 'writer-v2' };
  if (parts[0] === 'writer' && parts[1] && parts[1] !== 'runs') {
    return { name: 'writer-pack', id: parts[1]! };
  }
  if (parts[0] === 'writer') return { name: 'writer' };
  if (parts[0] === 'channel-styles' && parts[1]) {
    return { name: 'channel-styles', path: decodeURIComponent(parts[1]!) };
  }
  if (parts[0] === 'channel-styles') return { name: 'channel-styles' };
  if (parts[0] === 'training' && parts[1] === 'formulas' && parts[2]) return { name: 'training-formula', id: parts[2]! };
  if (parts[0] === 'training' && parts[1] === 'formulas') return { name: 'training-formulas' };
  if (parts[0] === 'training' && parts[1] === 'lab' && parts[2]) return { name: 'training-lab-run', id: parts[2]! };
  if (parts[0] === 'training' && parts[1] === 'lab') return { name: 'training-lab' };
  if (parts[0] === 'studio' && parts[1] === 'profiles' && parts[2]) {
    return { name: 'studio-profile', id: parts[2]! };
  }
  if (parts[0] === 'studio' && parts[1] === 'profiles') return { name: 'studio-profiles' };
  if (parts[0] === 'studio' && parts[1]) return { name: 'studio-session', id: parts[1]! };
  if (parts[0] === 'studio') return { name: 'studio' };
  if (parts[0] === 'agents') return { name: 'agents' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'home' };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home': return '#/';
    case 'spy': return '#/spy';
    case 'spy-run': return `#/spy/${route.id}`;
    case 'writer': return '#/writer';
    case 'writer-pack': return `#/writer/${route.id}`;
    case 'writer-run': return `#/writer/runs/${route.id}`;
    case 'writer-v2': return '#/writer/v2';
    case 'writer-v2-run': return `#/writer/v2/${route.id}`;
    case 'channel-styles':
      return route.path ? `#/channel-styles/${encodeURIComponent(route.path)}` : '#/channel-styles';
    case 'training-formulas': return '#/training/formulas';
    case 'training-formula': return `#/training/formulas/${route.id}`;
    case 'training-lab': return '#/training/lab';
    case 'training-lab-run': return `#/training/lab/${route.id}`;
    case 'studio': return '#/studio';
    case 'studio-session': return `#/studio/${route.id}`;
    case 'studio-profiles': return '#/studio/profiles';
    case 'studio-profile': return `#/studio/profiles/${route.id}`;
    case 'agents': return '#/agents';
    case 'settings': return '#/settings';
  }
}
