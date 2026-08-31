import { href } from '../router.ts';

export type StudioTabKey = 'studio' | 'lab' | 'formulas';

interface StudioSubNavProps {
  currentTab: StudioTabKey;
}

export function StudioSubNav({ currentTab }: StudioSubNavProps) {
  return (
    <nav class="studio-subnav-bar" aria-label="Studio Sub-tabs">
      <a
        class={`studio-subnav-pill ${currentTab === 'studio' ? 'active' : ''}`}
        href={href({ name: 'studio' })}
      >
        <span>🏛 Studio</span>
      </a>
      <a
        class={`studio-subnav-pill ${currentTab === 'lab' ? 'active' : ''}`}
        href={href({ name: 'training-lab' })}
      >
        <span>🔬 Training Lab</span>
      </a>
      <a
        class={`studio-subnav-pill ${currentTab === 'formulas' ? 'active' : ''}`}
        href={href({ name: 'training-formulas' })}
      >
        <span>🧪 Formula</span>
      </a>
    </nav>
  );
}
