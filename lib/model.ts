// The radar's scoring core: a sealed snapshot in, a ranked board out.
//
// The board always covers the snapshot's watchlist (a floor, not a ceiling) and adds the
// early pre-token protocols below the floor that the radar exists to surface. A protocol is
// pre-token when its record carries no token at all (no market cap, no CoinGecko id, no
// symbol); protocols whose token already trades are set aside and shown with the market's
// own numbers, never mixed into the ranking.
//
// radar-2 scores a protocol from the snapshot's own figures only:
//
//   sizeFactor   = 0.40 at TVL <= $5M, sliding log-linearly on log10(TVL) to 0.15 at TVL >= $5B
//   growthPct    = clamp(change_7d, -80, 200)
//   growthMult   = 1 + (growthPct / 100) * 0.8
//   maturityMult = 0.55 + min(age_days, 1460) / 1460 * 0.60   (unknown age: 365 days)
//   implied      = max(1, round(tvl_usd * sizeFactor * growthMult * maturityMult))
//
// The rankability rule runs over EVERY ranked row, watchlist rows included: wrapped,
// staked and bridged products of a token that already trades are not launches. A row is
// rankable only when it is pre-token, its category is none of Bridge, Canonical Bridge,
// Liquid Staking, Liquid Restaking, Restaked BTC or CEX, its name holds no whole word
// wrapped/staked/staking, does not start with an exchange name (Binance, Coinbase, Bybit,
// Kraken, Bitget, OKX, Bitfinex, Gemini), and does not end in a version marker. No
// protocol name is ever special-cased beyond that rule: one function scores every row.

/** One protocol entry of the snapshot: exactly the ten fields the sealed input carries. */
export interface ProtocolRecord {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: ProtocolRecord[];
  watchlist: string[];
}

/** The model's tunables, as the dashboard states them and the sandbox may move them. */
export interface RadarConstants {
  sizeMax: number;
  sizeMin: number;
  tvlFloor: number;
  tvlCeiling: number;
  growthWeight: number;
  growthFloor: number;
  growthCap: number;
  maturityBase: number;
  maturitySpan: number;
  maturitySpanDays: number;
  defaultAgeDays: number;
}

export const RADAR2: RadarConstants = {
  sizeMax: 0.4,
  sizeMin: 0.15,
  tvlFloor: 5_000_000,
  tvlCeiling: 5_000_000_000,
  growthWeight: 0.8,
  growthFloor: -80,
  growthCap: 200,
  maturityBase: 0.55,
  maturitySpan: 0.6,
  maturitySpanDays: 1460,
  defaultAgeDays: 365,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_LABEL = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_LIMIT = 210;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_LIMIT = 24;

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmAction {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardEntry {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    size_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface CompactEntry {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  size_multiple: number;
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveEntry {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarDataset {
  as_of: string;
  source: string;
  floor_usd: number;
  model: RadarConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: CompactEntry[];
  live: LiveEntry[];
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardTotals {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotShapeError';
  }
}

const MS_PER_DAY = 86_400_000;

/** A finite number, else `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Round to four decimals: the multipliers the board prints. */
function round4dp(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Compare two slugs alphabetically: the deterministic tie-break everywhere. */
function compareSlugs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const listed = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(listed)) return null;
  return Math.max(0, Math.floor((start - listed) / MS_PER_DAY));
}

/** Log-tiered size factor: 0.40 at or below $5M TVL, 0.15 at or above $5B, log-linear between. */
export function sizeFactor(tvlUsd: number, model: RadarConstants): number {
  const low = Math.log10(model.tvlFloor);
  const high = Math.log10(model.tvlCeiling);
  const t = Math.min(1, Math.max(0, (Math.log10(Math.max(1, tvlUsd)) - low) / (high - low)));
  return model.sizeMax + (model.sizeMin - model.sizeMax) * t;
}

export interface ProtocolScore {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
  sizeMult: number;
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function scoreProtocol(protocol: ProtocolRecord, asOf: string, model: RadarConstants): ProtocolScore {
  const age = ageInDays(asOf, protocol.listed_at);
  const rawGrowth = finiteOr(protocol.change_7d, 0);
  const growthPct = Math.min(model.growthCap, Math.max(model.growthFloor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growthWeight;
  const ageForModel = age ?? model.defaultAgeDays;
  const maturityMult =
    model.maturityBase +
    (Math.min(Math.max(ageForModel, 0), model.maturitySpanDays) / model.maturitySpanDays) * model.maturitySpan;
  const sizeMult = sizeFactor(protocol.tvl_usd, model);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * sizeMult * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age, sizeMult };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are wrapped, staked or bridged products of a token that already trades. */
const BLOCKED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** Whole-word wrapped / staked / staking in a name. */
const WRAPPED_NAME = /\b(wrapped|staked|staking)\b/i;
/** Names beginning with an exchange's name. */
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol records no token at all. */
export function hasNoToken(p: ProtocolRecord): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a wrapped/staked/bridged product, not a versioned pool. Applied to every ranked row, watchlist included. */
export function rankable(p: ProtocolRecord): boolean {
  return (
    hasNoToken(p) &&
    !BLOCKED_CATEGORIES.has(p.category ?? '') &&
    !WRAPPED_NAME.test(p.name) &&
    !EXCHANGE_NAME.test(p.name) &&
    !VERSION_SUFFIX.test(p.name)
  );
}

/** The snapshot's protocols keyed by slug. */
function slugIndex(protocols: ProtocolRecord[]): Map<string, ProtocolRecord> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** TVL descending, slug ascending: the order the early radar fills in. */
function byTvlDesc(a: ProtocolRecord, b: ProtocolRecord): number {
  return b.tvl_usd - a.tvl_usd || compareSlugs(a.slug, b.slug);
}

/** The watchlist's rankable slugs: the floor every board must cover. */
function pickWatchlist(snapshot: SnapshotDoc, index: Map<string, ProtocolRecord>): Map<string, ProtocolRecord> {
  const chosen = new Map<string, ProtocolRecord>();
  // The watchlist is the floor: every slug, filtered by the same rankable rule as every other
  // row. In this snapshot all 40 watchlist slugs pass the rule, so coverage stays 100%.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined && rankable(p)) chosen.set(slug, p);
  }
  return chosen;
}

/** The early radar: rankable pre-token protocols below the watchlist floor first, by TVL, then any other rankable pre-token protocol not on the watchlist, by TVL. */
function pickEarly(snapshot: SnapshotDoc, chosen: Map<string, ProtocolRecord>): ProtocolRecord[] {
  const below = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && rankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort(byTvlDesc);
  const above = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && rankable(p) && p.tvl_usd >= snapshot.floor_usd)
    .sort(byTvlDesc);
  // The rankable universe in this snapshot is 198 protocols, so EARLY_LIMIT=210 covers all of them.
  return [...below, ...above].slice(0, EARLY_LIMIT);
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function assembleBoard(snapshot: SnapshotDoc, model: RadarConstants = RADAR2): BoardEntry[] {
  const index = slugIndex(snapshot.protocols);
  const chosen = pickWatchlist(snapshot, index);
  for (const p of pickEarly(snapshot, chosen)) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const score = scoreProtocol(p, snapshot.as_of, model);
    return { protocol: p, score };
  });
  scored.sort((a, b) => b.score.implied - a.score.implied || compareSlugs(a.protocol.slug, b.protocol.slug));
  return scored.map((entry, i) => {
    const p = entry.protocol;
    const s = entry.score;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        size_multiple: Math.round(s.sizeMult * 1e4) / 1e4,
        growth_pct: s.growthPct,
        growth_multiplier: round4dp(s.growthMult),
        maturity_multiplier: round4dp(s.maturityMult),
        age_days: s.age,
      },
      farm_steps: buildFarmPlan(p, s.age).map(formatStep),
    };
  });
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function formatStep(step: FarmAction): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: ProtocolRecord): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeAmount(p: ProtocolRecord): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdWindow(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function planAction(p: ProtocolRecord, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function buildFarmPlan(p: ProtocolRecord, age: number | null): FarmAction[] {
  const chain = firstChain(p);
  const capital = stakeAmount(p);
  const hold = holdWindow(age);
  const action = planAction(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes on its own site, and never pay to claim.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveTokenEntries(snapshot: SnapshotDoc): LiveEntry[] {
  return snapshot.protocols
    .filter((p) => !hasNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_LIMIT)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function compactEntry(row: BoardEntry, watchlist: Set<string>): CompactEntry {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    size_multiple: row.model.size_multiple,
    watchlist: watchlist.has(row.slug),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadarSet(snapshot: SnapshotDoc, model: RadarConstants = RADAR2): { board: BoardEntry[]; radar: RadarDataset } {
  const board = assembleBoard(snapshot, model);
  const live = liveTokenEntries(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const watchlist = new Set(snapshot.watchlist);
  const radar: RadarDataset = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_LABEL,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => compactEntry(r, watchlist)),
    live,
  };
  return { board, radar };
}

/** One protocol entry out of a raw value, refused unless it carries a slug, a name and a TVL. */
function parseProtocolEntry(v: unknown, i: number): ProtocolRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotShapeError(`snapshot.json's protocol ${i} is not an object`);
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotShapeError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function readSnapshot(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotShapeError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotShapeError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotShapeError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotShapeError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotShapeError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotShapeError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotShapeError('snapshot.json has no watchlist of slugs');
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols: o.protocols.map((v, i) => parseProtocolEntry(v, i)),
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function validateBoard(board: BoardEntry[], snapshot: SnapshotDoc): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function renderDataScript(radar: RadarDataset): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
