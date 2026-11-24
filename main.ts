// Entry point: runs the early-bird sniper strategy against the replay harness.
//
// Final tuned params (dev window: net +0.0355 SOL, win rate 20.0%,
// max drawdown 1.0%, 90 round trips on 90 distinct mints):
// buy only in a coin's first 3 slots, only when exactly 2 distinct
// non-creator buyers have piled in, the creator bought at most 1 SOL and
// has not sold; exit on +10% / -8%, a trailing stop once up 8%, or 50 slots.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, type Params } from './strategy.ts';

const PARAMS: Params = {
  ...DEFAULT_PARAMS,
  maxAge: 3,
  stakeSol: 0.2,
  maxDevBuySol: 1.0,
  minBuyers: 2,
  maxBuyers: 2,
  tpBps: 1000,
  slBps: 800,
  trailArmBps: 800,
  trailBps: 400,
  maxHold: 50,
};

await runBot(createStrategy(PARAMS));
