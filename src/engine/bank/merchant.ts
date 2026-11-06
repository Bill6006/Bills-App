/**
 * Turns a bank's transaction text ("SQ *SHELL OIL 57444 ATLANTA GA") into a store name ("Shell"), a matching key
 * ("shell") and a kind (gas station, ATM, transfer, …). The same cleanup runs on notes you typed yourself, so
 * past logs like "walmart food" or "gas station food" teach the app too.
 */

export type MerchantKind = 'gas' | 'atm' | 'transfer' | 'payroll' | 'cardPayment' | 'p2p' | 'fee' | 'interest';

export interface MerchantInfo {
  /** Display name, e.g. "Shell". */
  name: string;
  /** Matching key, e.g. "shell"; '' when the text names no store (e.g. "gas station food"). */
  key: string;
  kind?: MerchantKind;
  /** True when the name came from the list of known stores. */
  known: boolean;
}

// Known stores: [pattern on the cleaned text, display name, kind]. Fuel brands are gas stations.
const KNOWN: Array<[RegExp, string, MerchantKind?]> = [
  [/\b(amzn|amazon)\b/, 'Amazon'],
  [/\bwal ?mart\b|\bwm supercenter\b/, 'Walmart'],
  [/\b(7 ?eleven|7 11)\b/, '7-Eleven', 'gas'],
  [/\bmc ?donald ?s?\b/, "McDonald's"],
  [/\bchick ?fil ?a\b/, 'Chick-fil-A'],
  [/\bbuc ?ee ?s?\b/, "Buc-ee's", 'gas'],
  [/\bcircle ?k\b/, 'Circle K', 'gas'],
  [/\bquik ?trip\b|\bqt ?\d/, 'QuikTrip', 'gas'],
  [/\bexxon ?(mobil)?\b|\bmobil\b/, 'Exxon Mobil', 'gas'],
  [/\bshell\b/, 'Shell', 'gas'],
  [/\bchevron\b/, 'Chevron', 'gas'],
  [/\bbp\b/, 'BP', 'gas'],
  [/\btexaco\b/, 'Texaco', 'gas'],
  [/\bcitgo\b/, 'Citgo', 'gas'],
  [/\bsunoco\b/, 'Sunoco', 'gas'],
  [/\bmarathon (petro|oil|gas)?/, 'Marathon', 'gas'],
  [/\bvalero\b/, 'Valero', 'gas'],
  [/\bspeedway\b/, 'Speedway', 'gas'],
  [/\brace ?trac\b/, 'RaceTrac', 'gas'],
  [/\braceway\b/, 'RaceWay', 'gas'],
  [/\bwawa\b/, 'Wawa', 'gas'],
  [/\bsheetz\b/, 'Sheetz', 'gas'],
  [/\bmurphy ?(usa|express|oil)\b/, 'Murphy USA', 'gas'],
  [/\bkwik ?trip\b/, 'Kwik Trip', 'gas'],
  [/\bcasey ?s (gen|store|#)|\bcaseys\b/, "Casey's", 'gas'],
  [/\bpilot (travel|#|\d)|\bpilot ?flying ?j\b|\bflying ?j\b/, 'Pilot Flying J', 'gas'],
  [/\blove ?s (travel|country|#)/, "Love's", 'gas'],
  [/\barco\b/, 'ARCO', 'gas'],
  [/\bphillips ?66\b/, 'Phillips 66', 'gas'],
  [/\bconoco\b/, 'Conoco', 'gas'],
  [/\bsinclair\b/, 'Sinclair', 'gas'],
  [/\bgulf oil\b|^gulf\b/, 'Gulf', 'gas'],
  [/\bkangaroo\b/, 'Kangaroo Express', 'gas'],
  [/\bthorntons\b/, 'Thorntons', 'gas'],
  [/\bmaverik\b/, 'Maverik', 'gas'],
  [/\bcumberland farms\b/, 'Cumberland Farms', 'gas'],
  [/\bholiday station/, 'Holiday', 'gas'],
  [/\bgetgo\b/, 'GetGo', 'gas'],
  [/\bstewart ?s shop/, "Stewart's", 'gas'],
  [/\btaco bell\b/, 'Taco Bell'],
  [/\bwendy ?s?\b/, "Wendy's"],
  [/\bcook ?out\b/, 'Cook Out'],
  [/\bpan[ae]ra/, 'Panera Bread'],
  [/\bstarbucks\b/, 'Starbucks'],
  [/\bdunkin\b/, "Dunkin'"],
  [/\bdutch ?bros\b/, 'Dutch Bros'],
  [/\bsmoothie king\b/, 'Smoothie King'],
  [/\bapplebee ?s?\b/, "Applebee's"],
  [/\bburger king\b/, 'Burger King'],
  [/\bpopeyes\b/, 'Popeyes'],
  [/\bsubway\b/, 'Subway'],
  [/\bchipotle\b/, 'Chipotle'],
  [/\bzaxby ?s?\b/, "Zaxby's"],
  [/\bsonic\b/, 'Sonic'],
  [/\bdomino ?s\b/, "Domino's"],
  [/\bpizza hut\b/, 'Pizza Hut'],
  [/\bpapa john/, "Papa John's"],
  [/\bdoordash\b/, 'DoorDash'],
  [/\buber ?eats\b/, 'Uber Eats'],
  [/\bgrubhub\b/, 'Grubhub'],
  [/\binstacart\b/, 'Instacart'],
  [/\bkroger\b/, 'Kroger'],
  [/\btarget\b/, 'Target'],
  [/\bcostco\b/, 'Costco'],
  [/\bsam ?s ?club\b/, "Sam's Club"],
  [/\baldi\b/, 'Aldi'],
  [/\blidl\b/, 'Lidl'],
  [/\bpublix\b/, 'Publix'],
  [/\bfood lion\b/, 'Food Lion'],
  [/\bharris teeter\b/, 'Harris Teeter'],
  [/\bh ?e ?b\b/, 'H-E-B'],
  [/\bsafeway\b/, 'Safeway'],
  [/\bmeijer\b/, 'Meijer'],
  [/\bwhole foods\b/, 'Whole Foods'],
  [/\btrader joe/, "Trader Joe's"],
  [/\bdollar general\b/, 'Dollar General'],
  [/\bdollar tree\b/, 'Dollar Tree'],
  [/\bfamily dollar\b/, 'Family Dollar'],
  [/\bfive below\b/, 'Five Below'],
  [/\bwalgreens\b/, 'Walgreens'],
  [/\bcvs\b/, 'CVS'],
  [/\brite aid\b/, 'Rite Aid'],
  [/\bross\b/, 'Ross'],
  [/\btj ?maxx\b/, 'TJ Maxx'],
  [/\bmarshalls\b/, 'Marshalls'],
  [/\bold navy\b/, 'Old Navy'],
  [/\bhome depot\b/, 'Home Depot'],
  [/\blowe ?s\b/, "Lowe's"],
  [/\bbest buy\b/, 'Best Buy'],
  [/\bfactor ?(75|com)?\b/, 'Factor'],
  [/\bopen ?ai\b|\bchatgpt\b/, 'OpenAI'],
  [/\bnetflix\b/, 'Netflix'],
  [/\bspotify\b/, 'Spotify'],
  [/\bhulu\b/, 'Hulu'],
  [/\bapple ?com ?bill\b|\bapple services\b/, 'Apple'],
  [/\bgoogle (play|storage|one)\b/, 'Google'],
  [/\bkiwi ?co\b/, 'KiwiCo'],
];

const STATES = new Set('al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc pr'.split(' '));
const STOP = new Set(['the', 'and', 'of', 'a', 'an', 'inc', 'llc', 'co', 'corp', 'ltd', 'store', 'stores', 'shop', 'purchase', 'www', 'com', 'net', 'org', 'us', 'usa', 'food', 'stuff']);
/** Words too common to identify a store on their own; the next word is added to the key. */
const GENERIC = new Set(['new', 'big', 'best', 'my', 'el', 'la', 'los', 'las', 'san', 'st', 'saint', 'fresh', 'family', 'home', 'city', 'super', 'mini', 'quick', 'express', 'dollar', 'golden', 'royal', 'little', 'first', 'great', 'happy', 'sun', 'star', 'one', 'top', 'blue', 'red', 'green', 'north', 'south', 'east', 'west']);

// Leading words banks put before the store name.
const LEADING = /^(?:(?:pos|dbt|debit|ach|card|visa|mc|mastercard|checkcard|check ?card|chk ?card|purchase|recurring|rec|pre ?auth|pending|point of sale|withdrawal|web|online|pmt|payment to|sale|return|refund|credit|debit card|cr|dr|electronic|transaction|trans|tst|sq|sp|py|pp|ppl|paypal|zettle|clover|toast|stripe|apl|eb)\b[\s:*#-]*)+/;

/** Lowercase, drop punctuation and reference numbers, but keep words. */
function tidy(raw: string): string {
  let s = String(raw || '').toLowerCase();
  s = s.replace(/purchase authorized on \d{1,2}\/\d{1,2}/g, ' ');
  s = s.replace(/\b(card|crd)\s*(ending|#|no\.?)?\s*\d{4}\b/g, ' ');
  s = s.replace(/x{2,}\d{2,4}/g, ' ');
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ');
  s = s.replace(/['’`]/g, '');
  s = s.replace(/([a-z])-([a-z])/g, '$1$2');
  s = s.replace(/\.com\b/g, ' com');
  s = s.replace(/[^a-z0-9& ]+/g, ' ');
  s = s.replace(/&/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const title = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

function kindOf(t: string, knownKind?: MerchantKind): MerchantKind | undefined {
  if (/\b(payroll|direct dep|dir dep|salary|paycheck|ppd payroll)\b/.test(t)) return 'payroll';
  if (/\b(transfer|xfer|trnsfr|tfr)\b|\b(to|from) (savings|checking|share|sav|chk)\b/.test(t)) return 'transfer';
  if (/\b(payment thank you|thank you payment|autopay|auto pay|credit card payment|card payment|epayment|e payment|mobile payment|online payment|bill payment|crcardpmt|payment received)\b/.test(t)) return 'cardPayment';
  if (/\b(atm|cash withdrawal|withdrawal at|cash wd)\b/.test(t)) return 'atm';
  if (/\b(venmo|zelle|cash ?app|sq ?cash|apple cash|paypal transfer)\b/.test(t)) return 'p2p';
  if (/\binterest (paid|earned|payment)\b|\bdividend\b/.test(t)) return 'interest';
  if (/\b(overdraft|nsf|service charge|monthly fee|maintenance fee|atm fee|late fee|foreign transaction fee)\b/.test(t)) return 'fee';
  if (knownKind) return knownKind;
  if (/\b(fuel|gasoline|gas station|petro|petroleum|gas)\b/.test(t)) return 'gas';
  return undefined;
}

/** Store name, key and kind for bank text or a note you typed. */
export function describeMerchant(raw: string): MerchantInfo {
  const t = tidy(raw);
  if (!t) return { name: '', key: '', known: false };
  for (const [re, name, kind] of KNOWN) {
    if (!re.test(t)) continue;
    let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let display = name;
    let k = kindOf(t, kind);
    // "Kroger Fuel", "Costco Gas": a grocery store's pumps are their own store.
    if (kind !== 'gas' && /\b(fuel|gas|gasoline)\b/.test(t)) { key += 'fuel'; display += ' Fuel'; k = 'gas'; }
    return { name: display, key, kind: k, known: true };
  }
  const kind = kindOf(t);
  const stripped = t.replace(LEADING, '').trim() || t;
  const words: string[] = [];
  for (const w of stripped.split(' ')) {
    if (/\d{3,}/.test(w) || /^#/.test(w)) break; // store numbers and references come after the name
    if (/^\d+$/.test(w)) continue;
    words.push(w);
  }
  while (words.length > 1 && STATES.has(words[words.length - 1])) words.pop();
  const sig = words.filter((w) => w.length > 1 && !STOP.has(w));
  if (kind === 'atm') return { name: 'ATM withdrawal', key: 'atm', kind, known: false };
  if (kind === 'p2p') {
    const raw = t.match(/\b(zelle|venmo|cash ?app|sq ?cash|apple cash|paypal)\b/)?.[1] || '';
    const svc = ({ zelle: 'Zelle', venmo: 'Venmo', 'cash app': 'Cash App', cashapp: 'Cash App', 'sq cash': 'Cash App', sqcash: 'Cash App', 'apple cash': 'Apple Cash', paypal: 'PayPal' } as Record<string, string>)[raw] || 'Payment';
    const to = t.match(/\b(to|from)\s+([a-z][a-z ]{1,40})/);
    const who = to ? to[2].split(' ').filter((w) => w && !STOP.has(w) && !/^(payment|transfer|conf|id|ref)$/.test(w)).slice(0, 3).join(' ') : '';
    return { name: who ? `${svc} ${to![1]} ${title(who)}` : svc, key: `${svc.toLowerCase().replace(/\s+/g, '')}${who ? `:${who.replace(/\s+/g, '')}` : ''}`, kind, known: false };
  }
  if (kind === 'transfer' || kind === 'cardPayment' || kind === 'payroll' || kind === 'interest') {
    return { name: title(words.slice(0, 4).join(' ')) || title(t.split(' ').slice(0, 3).join(' ')), key: kind, kind, known: false };
  }
  if (kind === 'gas' && sig.every((w) => /^(gas|stations?|fuel|food|random|gasoline|stop|mart|items?|snacks?)$/.test(w))) {
    return { name: 'Gas station', key: '', kind, known: false };
  }
  if (!sig.length) return { name: title(stripped.split(' ').slice(0, 3).join(' ')), key: '', kind, known: false };
  const keyWords = GENERIC.has(sig[0]) && sig.length > 1 ? sig.slice(0, 2) : sig.slice(0, 1);
  return { name: title(words.slice(0, Math.min(3, words.length)).join(' ')), key: keyWords.join(''), kind, known: false };
}

/** Levenshtein distance, for small typos like "panarabread". */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Whether two store keys are the same store (exact, or one long key a small typo away from the other). */
export function sameStore(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 6 && b.length >= 6 && editDistance(a, b) <= 1) return true;
  return false;
}
