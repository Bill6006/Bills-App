/** Backup files: the new app's own format, plus detection of v117 exports. */
import type { IsoDate } from '../engine/dates';
import type { AppData } from '../engine/types';
import { describePay, importV117, looksLikeV117, type ImportResult } from './importV117';
import { upgradeData } from './upgrade';

export interface BackupFile { app: 'bills-planner'; format: 1; exportedAt: string; data: AppData }

export function makeBackupText(data: AppData, nowIso = new Date().toISOString()): string {
  const file: BackupFile = { app: 'bills-planner', format: 1, exportedAt: nowIso, data };
  return JSON.stringify(file, null, 2);
}

export const backupFileName = (today: IsoDate) => `bills-planner-backup-${today}.json`;

/** Reads either a Bills Planner backup or a v117 export. Throws with a readable message otherwise. */
export function parseImportText(text: string, today: IsoDate, fileName?: string): ImportResult {
  let obj: unknown;
  try {
    obj = JSON.parse(String(text || '').trim());
  } catch {
    throw new Error("That isn't a valid backup file. It should be a .json file exported from Bills Planner or Bills Account Planner.");
  }
  const o = obj as Partial<BackupFile> & Record<string, unknown>;
  if (o && o.app === 'bills-planner' && o.data) {
    const data = upgradeData(o.data, today);
    return {
      data,
      report: {
        source: 'backup',
        counts: {
          bills: data.bills.length, budgets: data.extras.length, loans: data.debts.length,
          loanPayments: data.debts.reduce((n, d) => n + d.payments.length, 0), spendLogs: data.spendEntries.length,
          budgetMoves: data.spendTransfers.length, withdrawals: data.events.length, extraIncomes: data.settings.otherIncomes.length,
        },
        paycheck: describePay(data.settings.pay),
        balances: { savings: data.settings.baseSavingsBalance, savingsMonth: data.settings.trueSavingsMonth },
        notes: o.exportedAt ? [`Backup made ${String(o.exportedAt).slice(0, 10)}.`] : [],
      },
    };
  }
  if (looksLikeV117(obj)) return importV117(obj, today, { fileName });
  throw new Error("This file doesn't look like a Bills Planner backup or a Bills Account Planner export.");
}

/** Saves a text file: the share sheet on phones that support files, otherwise a normal download. */
export async function saveTextFile(text: string, fileName: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = new Blob([text], { type: 'application/json' });
  try {
    const file = new File([blob], fileName, { type: 'application/json' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare && nav.canShare({ files: [file] }) && /iphone|ipad|android/i.test(navigator.userAgent)) {
      await nav.share({ files: [file], title: fileName });
      return 'shared';
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return 'cancelled';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later; revoking immediately can cancel the download in some browsers (v117 bug).
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
