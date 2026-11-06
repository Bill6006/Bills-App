import { useEffect, useLayoutEffect, useRef } from 'react';
import { navigate, useRoute } from './router';
import { Sidebar, TabBar } from './Shell';
import { ToastHost } from '../ui/components/ToastHost';
import { SheetHost } from '../ui/components/Sheet';
import { discardWhatIf, hydrate, keepWhatIf, replaceAll, useActive, useStore } from '../state/store';
import { isEmptyData, makeDefaultData } from '../data/defaults';
import { Home } from '../ui/screens/Home';
import { Timeline } from '../ui/screens/Timeline';
import { Welcome } from '../ui/screens/Welcome';
import { Spending } from '../ui/screens/Spending';
import { Plan } from '../ui/screens/plan/PlanHub';
import { openQuickAdd } from '../ui/sheets/QuickAdd';
import type { ThemePref } from '../engine/types';

function applyTheme(theme: ThemePref) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#0B1310');
}

/** Keeps --banner-h equal to the fixed banner's height so the page never slides under it. */
function useBannerHeight(kind: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!kind || !el) { root.style.removeProperty('--banner-h'); return; }
    const set = () => root.style.setProperty('--banner-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [kind]);
  return ref;
}

function useTheme(theme: ThemePref) {
  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const on = () => applyTheme(theme);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);
}

export function App() {
  const hydrated = useStore((s) => s.hydrated);
  const whatIf = useStore((s) => s.whatIf);
  const realData = useStore((s) => s.data);
  const today = useStore((s) => s.today);
  const data = useActive();
  const route = useRoute();
  useTheme(data.prefs.theme);
  useEffect(() => { void hydrate(); }, []);
  const banner = !hydrated ? null : whatIf ? 'whatif' : realData.meta.sample ? 'sample' : null;
  const bannerRef = useBannerHeight(banner);

  if (!hydrated) {
    return <div className="splash" aria-label="Loading"><span className="brand-mark big">B</span></div>;
  }

  const empty = isEmptyData(realData) && !realData.meta.importedFrom;
  let screen;
  switch (route.tab) {
    case 'timeline': screen = <Timeline monthParam={route.parts[1]} />; break;
    case 'spending': screen = <Spending sub={route.parts[1]} />; break;
    case 'plan': screen = <Plan parts={route.parts.slice(1)} />; break;
    default: screen = empty ? <Welcome /> : <Home />;
  }

  return (
    <div className="shell">
      {banner === 'whatif' && (
        <div className="banner whatif" role="status" ref={bannerRef}>
          <div className="grow"><div>What-if mode</div><div className="sub">Changes here aren't saved until you keep them.</div></div>
          <button type="button" className="btn sm ghost" onClick={discardWhatIf}>Discard</button>
          <button type="button" className="btn sm" onClick={keepWhatIf}>Keep</button>
        </div>
      )}
      {banner === 'sample' && (
        <div className="banner sample" role="status" ref={bannerRef}>
          <div className="grow"><div>Sample data</div><div className="sub">Made-up numbers to look around with.</div></div>
          <button type="button" className="btn sm ghost" onClick={() => { replaceAll(makeDefaultData(today), 'Sample data cleared.'); navigate('/'); }}>Clear</button>
        </div>
      )}
      <Sidebar active={route.tab} onAdd={openQuickAdd} />
      <main className={`main${banner ? ' has-banner' : ''}`} id="main" key={route.tab}>
        {screen}
      </main>
      <TabBar active={route.tab} onAdd={openQuickAdd} />
      <SheetHost />
      <ToastHost />
    </div>
  );
}
