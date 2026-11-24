// Pump.fun Replay Sprint — paper bot for the agent-fun/replay/v2 harness.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is vendored byte for byte in vendor/agentfun-bot.ts.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
