import type { ReactNode } from 'react';
import { navigate } from '../../app/router';
import { closeAllSheets, openSheet } from '../../state/sheets';
import { Sheet } from '../components/Sheet';
import { IconCard, IconDollar, IconEnvelope, IconFile, IconMove, IconReceipt, IconTrend } from '../icons';
import { openImport } from './ImportSheet';
import { quickActions } from './quickActions';

export function openQuickAdd() {
  openSheet((close) => <QuickAddSheet onClose={close} />);
}

function Action({ icon, tone, title, sub, onClick }: { icon: ReactNode; tone: string; title: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" className="row qa-row" onClick={onClick}>
      <span className={`icon-badge ${tone}`}>{icon}</span>
      <span className="main-col"><span className="title-wrap strong">{title}</span><span className="sub">{sub}</span></span>
      <span />
    </button>
  );
}

function QuickAddSheet({ onClose }: { onClose: () => void }) {
  const then = (fn: () => void) => () => { closeAllSheets(); window.setTimeout(fn, 240); };
  const qa = quickActions;
  return (
    <Sheet title="Add" onClose={onClose}>
      <div className="card flush"><div className="list">
        <Action icon={<IconEnvelope />} tone="p" title="Log spending" sub="A purchase or a refund" onClick={then(() => (qa.logSpend ? qa.logSpend() : navigate('/spending')))} />
        <Action icon={<IconFile />} tone="p" title="Import from your bank" sub="A CSV, QFX or OFX download; purchases get filed for you" onClick={then(() => (qa.bankImport ? qa.bankImport() : navigate('/spending/import')))} />
        <Action icon={<IconMove />} tone="p" title="Move money between budgets" sub="Shift spending money from one budget to another" onClick={then(() => (qa.moveMoney ? qa.moveMoney() : navigate('/spending')))} />
        <Action icon={<IconReceipt />} tone="b" title="Add a bill" sub="Paid from the Bills account" onClick={then(() => navigate('/plan/bills/new'))} />
        <Action icon={<IconCard />} tone="b" title="Log a loan payment" sub="Only needed when it was different from the plan" onClick={then(() => navigate('/plan/loans'))} />
        <Action icon={<IconTrend />} tone="s" title="Plan a savings withdrawal" sub="Gifts, travel, a big purchase" onClick={then(() => navigate('/plan/savings/new'))} />
        <Action icon={<IconDollar />} tone="s" title="Add extra income" sub="A bonus, side gig or refund" onClick={then(() => navigate('/plan/income/extra-new'))} />
        <Action icon={<IconFile />} tone="n" title="Restore a backup" sub="Or import from Bills Account Planner" onClick={then(openImport)} />
      </div></div>
    </Sheet>
  );
}
