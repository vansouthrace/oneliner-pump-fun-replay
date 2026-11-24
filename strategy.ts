// Early-bird sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: on pump.fun almost every new curve bleeds out within minutes, so the
// only durable edge is to be in at the very start, on launches that look
// honest, and to leave fast. This bot watches every coin from its
// CreateEvent and buys only in its first few slots, and only when the
// opening tape looks clean: the creator has not sold, the creator's own buy
// is small, the launch is not bundled across many wallets, real SOL is
// flowing in, and the price has not already run away. It takes one fixed
// stake per coin, then exits on a take-profit, a stop-loss, a trailing stop
// once the trade is working, a hard time limit, or the moment the creator
// sells. One buy per coin, no pyramiding, no re-entry.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration
// only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;
/** Curve fees taken on a sale (protocol 95 + creator 30 bps). */
const FEE_BPS = 125n;

export interface Params {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to put into one position. */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for, in SOL. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot, at most, in SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most (bundled launches dump). */
  maxBuyers: number;
  /** Distinct non-creator buyers seen before entry, at least (need some interest). */
  minBuyers: number;
  /** Price now over the create price, at most, in bps (avoid chasing a run-up). */
  maxRunupBps: number;
  /** Recent net flow (buys minus sells, SOL) over the flow window, at least. */
  minFlowSol: number;
  /** Recent-flow window, in slots. */
  flowWindow: number;
  /** Slippage allowed on buys, in bps. */
  buySlipBps: number;
  /** Sell when the position is worth this much over its cost, in bps. */
  tpBps: number;
  /** Sell when it is worth this much under its cost, in bps. */
  slBps: number;
  /** Trailing stop arms once up this much over cost, in bps. */
  trailArmBps: number;
  /** Once armed, sell on a fall of this much from the best value, in bps. */
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 3,
  stakeSol: 0.1,
  minBuySol: 0.005,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 2.5,
  maxBuyers: 3,
  minBuyers: 0,
  maxRunupBps: 100_000,
  minFlowSol: -100,
  flowWindow: 10,
  buySlipBps: 10_000,
  tpBps: 1500,
  slBps: 1200,
  trailArmBps: 1_000_000,
  trailBps: 1000,
  maxHold: 10,
  staleSlots: 1_000_000,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  boughtOnce: boolean;
  done: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const stake = BigInt(Math.round(p.stakeSol * 1e9));
  const minBuy = BigInt(Math.round(p.minBuySol * 1e9));

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          boughtOnce: false,
          done: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.done = true;
      }
    }
  }

  /** Net lamports bought minus sold over the last flowWindow slots. */
  function flow(c: Coin, slot: number): bigint {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const o of state.pending.values()) {
      if (o.order.mint === mint && o.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const o of state.pending.values()) {
      if (o.order.mint === mint && o.order.side === 'sell') return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Track fills: register new positions, drop harness-closed ones.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) {
        if (!hasPendingSell(state, mint)) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) {
          held.delete(mint);
        }
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(BigInt(pos.token_amount), mk.vq, mk.vt) - tx;
        const basis = BigInt(pos.cost_lamports) + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.slBps))) exit = true;
          if (
            h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) &&
            value * BPS <= h.best * (BPS - BigInt(p.trailBps))
          ) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: BigInt(pos.token_amount), max_slippage_bps: 10000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: only coins still in their first few slots.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.boughtOnce) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(Math.round(p.minRealSol * 1e9)) || rq > BigInt(Math.round(p.maxRealSol * 1e9))) continue;
        if (c.devBuy > BigInt(Math.round(p.maxDevBuySol * 1e9))) continue;
        if (c.buyers.size > p.maxBuyers || c.buyers.size < p.minBuyers) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(p.maxRunupBps)) continue;
        if (flow(c, state.slot) < BigInt(Math.round(p.minFlowSol * 1e9))) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        c.boughtOnce = true;
        open += 1;
      }
      return orders;
    },
  };
}
