export type Route =
  | { name: 'home' }
  | { name: 'spy' }
  | { name: 'spy-run'; id: string }
  | { name: 'writer' }
  | { name: 'writer-pack'; id: string }
  | { name: 'settings' };

export function parseRoute(hash = location.hash): Route {
  const path = hash.replace(/^#\/?/, '') || '';
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'spy' && parts[1]) return { name: 'spy-run', id: parts[1]! };
  if (parts[0] === 'spy') return { name: 'spy' };
  if (parts[0] === 'writer' && parts[1]) return { name: 'writer-pack', id: parts[1]! };
  if (parts[0] === 'writer') return { name: 'writer' };
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
    case 'settings': return '#/settings';
  }
}
