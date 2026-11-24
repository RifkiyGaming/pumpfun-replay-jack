// Selective momentum / dip-riding bot for the pump.fun bonding-curve replay.
//
// Design notes (written for a 24-hour final window, so the defaults are
// deliberately patient and small):
//
// * A curve only becomes a buy once it is seasoned: at least `minAge` slots
//   since its CreateEvent. Fresh curves are mostly bundled launches that get
//   dumped within minutes, so the bot lets the first wave of sellers pass.
// * The entry tape must show real, spreading demand over `window` slots:
//   net SOL flowing in, several distinct buyers, no single wallet dominating
//   the buys, price up but not already vertical, price sitting near the
//   window high, and the newer half of the window out-flowing the older half
//   (acceleration, not a stale pump).
// * Entries start tiny (`initialSol`) and only pyramid into strength — the
//   price stepped up from the last buy, the position already in profit, and
//   net flow still positive — up to `stakeSol` per position. A false start
//   therefore costs a few hundredths of a SOL; a runner gets real size.
// * Every position is sold whole on the first of: a tight stop-loss against
//   cost, a trailing stop once the trade has shown a profit, a hard
//   take-profit (bank a big runner instead of watching it round-trip), a
//   fade in net flow, one very large recorded sell, or a max-hold limit
//   (which does not apply while the position is comfortably up — winners
//   are allowed to run through the clock).
// * Guardrail probes keep the run above the 20-coin / 200-fill bar: when the
//   bot's own fills or distinct coins lag a block-time pace across the full
//   24h window, it buys `probeSol` of a liquid curve and sells it as soon as
//   the buy lands. Probes are cheap (a hundredth of a SOL plus fees) and
//   only fire while the bot is behind pace.
//
// Determinism: no clock, no Date, no randomness, no I/O. All state lives in
// insertion-ordered Maps fed by the batch stream, and every iteration order
// follows batch order, so two graded executions produce identical logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Entry lookback in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1 (lower bound). */
  minPriceUp: number;
  /** Upper bound on that rise — skip curves that already ran too far. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Price now at least this share of the window high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL (cap). */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Sell when value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell when value falls below peak * (1 - trail), once armed. */
  trail: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Sell the whole position once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Fade lookback in slots. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless comfortably up). */
  maxHold: number;
  /** Position counts as "comfortably up" for the max-hold exemption at this gain. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the whole run. */
  maxEntries: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once (drawdown guard). */
  maxExposureSol: number;
  /** Keep at least this much free cash unspent (SOL). */
  reserveSol: number;
  /**
   * Guardrail pacing: the run must end with at least 20 distinct mints with
   * round trips of >= 0.01 SOL and plenty of fills. When the bot's own fills
   * or coins lag targetFills / targetCoins scaled by the share of paceSecs
   * elapsed (block time since the first batch), it opens tiny probe round
   * trips (buy probeSol, sell it all as soon as the buy lands).
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Defaults: tuned on the dev window with the pilot sim tooling, preferring
// flat regions of the grid over a single best cell, and sized for a 24h
// window (paceSecs = 86400). Small stakes + tight stops: the pilot's
// 2-SOL stakes lost ~9.4 SOL on this dev window with a 95% drawdown, so
// this bot risks roughly a tenth of that per position.
export const DEFAULT_PARAMS: Params = {
  window: 40,
  minNetSol: 1,
  minBuys: 4,
  minBuyers: 6,
  minPriceUp: 0.08,
  maxPriceUp: 0.8,
  accel: 1,
  nearHigh: 0.97,
  maxBuyerShare: 0.5,
  minRqSol: 3,
  maxRqSol: 40,
  minAge: 900,
  stakeSol: 0.3,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.1,
  trail: 0.12,
  trailArm: 0.06,
  takeProfit: 0.6,
  fadeWindow: 20,
  fadeNetSol: 0.15,
  bigSellSol: 2,
  maxHold: 900,
  holdIfUp: 0.2,
  cooldown: 300,
  maxEntries: 1,
  initialSol: 0.015,
  addSol: 0.06,
  addStep: 0.02,
  addIfUp: 0.03,
  addNetSol: 0.5,
  maxMain: 5,
  maxExposureSol: 1.2,
  reserveSol: 0.2,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 86400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface OpenPosition {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** At least one buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

/** One pass over a tape's window: everything the entry signal needs. */
interface WindowStats {
  trades: number;
  buys: number;
  buyers: number;
  topShare: number;
  net: number;
  netOld: number;
  netNew: number;
  up: number;
  nearHigh: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const held = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const netFlow = (t: CurveTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Summarise the entry window; null when there is nothing to judge. */
  const windowStats = (t: CurveTape, now: number): WindowStats | null => {
    const from = now - p.window;
    const mid = now - p.window / 2;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let trades = 0;
    let netOld = 0;
    let netNew = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      trades++;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (trades === 0 || startPrice <= 0 || last <= 0 || high <= 0) return null;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    return {
      trades,
      buys,
      buyers: byUser.size,
      topShare: buySol > 0 ? top / buySol : 1,
      net: buySol - sellSol,
      netOld,
      netNew,
      up: last / startPrice - 1,
      nearHigh: last >= high * p.nearHigh,
    };
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: CurveTape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const s = windowStats(t, now);
    if (s === null) return false;
    if (s.buys < p.minBuys || s.buyers < p.minBuyers) return false;
    if (s.net < p.minNetSol) return false;
    if (s.up < p.minPriceUp || s.up > p.maxPriceUp) return false;
    if (!s.nearHigh) return false;
    if (s.netNew <= 0 || s.netNew < p.accel * s.netOld) return false;
    if (s.topShare > p.maxBuyerShare) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();

      // Count only the bot's own filled orders (harness force-closes use
      // client ids starting with '_').
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }

      // Ingest the batch: creations seed tapes, trades extend them.
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      // Prune tapes that moved this batch.
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // --- Exits first: every open position is judged against all exit rules.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && netFlow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // --- Probe round trips: sell the whole probe as soon as its buy lands.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Pyramid into strength only: price stepped up from the last buy,
          // the position is already up, and net SOL still flows in.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          if (netFlow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx - p.reserveSol) amount = free - tx - p.reserveSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // --- Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
