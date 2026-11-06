import type { ReactNode } from 'react';
import { navigate, type TabKey } from './router';
import { IconGrid, IconHome, IconPlus, IconTimeline, IconWallet } from '../ui/icons';

const TABS: Array<{ key: TabKey; label: string; path: string; Icon: typeof IconHome }> = [
  { key: 'home', label: 'Home', path: '/', Icon: IconHome },
  { key: 'timeline', label: 'Timeline', path: '/timeline', Icon: IconTimeline },
  { key: 'spending', label: 'Spending', path: '/spending', Icon: IconWallet },
  { key: 'plan', label: 'Plan', path: '/plan', Icon: IconGrid },
];

export function Sidebar({ active, onAdd, footer }: { active: TabKey; onAdd: () => void; footer?: ReactNode }) {
  return (
    <aside className="sidebar" aria-label="Main">
      <div className="brand"><span className="brand-mark" aria-hidden="true">B</span>Bills Planner</div>
      {TABS.map(({ key, label, path, Icon }) => (
        <a key={key} className="nav-item" href={`#${path}`} aria-current={active === key ? 'page' : undefined}
          onClick={(e) => { e.preventDefault(); navigate(path); }}>
          <Icon />{label}
        </a>
      ))}
      <button type="button" className="btn sm nav-add" onClick={onAdd}><IconPlus />Add</button>
      <div className="sidebar-foot">{footer}</div>
    </aside>
  );
}

export function TabBar({ active, onAdd }: { active: TabKey; onAdd: () => void }) {
  const [a, b, c, d] = TABS;
  const tab = (t: (typeof TABS)[number]) => (
    <a key={t.key} className="tab" href={`#${t.path}`} aria-current={active === t.key ? 'page' : undefined}
      onClick={(e) => { e.preventDefault(); navigate(t.path); }}>
      <t.Icon />{t.label}
    </a>
  );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab(a)}{tab(b)}
      <button type="button" className="tab tab-add" onClick={onAdd} aria-label="Add">
        <span className="plus"><IconPlus /></span>
      </button>
      {tab(c)}{tab(d)}
    </nav>
  );
}
