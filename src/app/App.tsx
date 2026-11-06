import { useEffect } from 'react';
import { useRoute } from './router';
import { Sidebar, TabBar } from './Shell';
import { ToastHost } from '../ui/components/ToastHost';
import { Guilloche } from '../ui/components/Guilloche';
import { toast } from '../state/toast';

function useThemeColor() {
  useEffect(() => {
    const apply = () => {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#0B1310');
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
}

const TITLES = { home: 'Home', timeline: 'Timeline', spending: 'Spending', plan: 'Plan' } as const;

export function App() {
  const route = useRoute();
  useThemeColor();
  const onAdd = () => toast('Quick add arrives with the next update.');
  return (
    <div className="shell">
      <Sidebar active={route.tab} onAdd={onAdd} />
      <main className="main" id="main">
        <div className="page page-narrow" key={route.tab}>
          <div className="page-head"><div className="titles"><div className="eyebrow">Bills Planner</div><h1 className="page-title">{TITLES[route.tab]}</h1></div></div>
          <section className="hero">
            <Guilloche />
            <div className="lbl">Being rebuilt</div>
            <p style={{ fontWeight: 700, fontSize: 17, lineHeight: 1.4, maxWidth: 420 }}>The new Bills Planner is installing piece by piece. Next up: importing your data from v117 and the Home screen.</p>
            <p className="sub">Your data stays on this device. Nothing is uploaded.</p>
          </section>
        </div>
      </main>
      <TabBar active={route.tab} onAdd={onAdd} />
      <ToastHost />
    </div>
  );
}
