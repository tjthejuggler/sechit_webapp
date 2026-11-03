// Randomized full games over the real server: at every player count 5–10,
// run seeded complete games with random-but-legal bot behavior and assert the
// invariants: exactly one legal win condition, policy conservation, every
// phase visited, complete elections with all living voters, dead players
// excluded, every entitled player actually performed their actions, no socket
// errors and no invariant violations.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../../server/engine/index.js';
import { startServer, stopServer, GameTable } from './harness.js';
import { runGame, verifyGameOver } from './driver.js';

let fixture;

before(async () => { fixture = await startServer(); });
after(async () => { await stopServer(fixture); });

const GAMES_PER_COUNT = Number(process.env.BOT_GAMES_PER_COUNT ?? 10);
const COUNTS = [5, 6, 7, 8, 9, 10];

describe('randomized full bot games (5–10 players)', () => {
  for (const n of COUNTS) {
    describe(`${n} players`, () => {
      for (let g = 0; g < GAMES_PER_COUNT; g++) {
        test(`seeded game #${g + 1} terminates legally with all invariants`, { timeout: 60_000 }, async () => {
          const seed = 1000 * n + g;
          const rng = createRng(seed);
          const table = new GameTable(fixture, { label: `n=${n} game=${g + 1} seed=${seed}` });
          try {
            await table.addPlayers(n);
            await table.startGame();
            const { stats, phasesVisited } = await runGame(table, { rng });

            // 1. Exactly one legal win condition.
            const { winner } = verifyGameOver(table);

            // 2. Every gameplay phase was visited on the way.
            for (const p of ['NOMINATION', 'VOTE', 'LEGISLATIVE_PRESIDENT', 'LEGISLATIVE_CHANCELLOR']) {
              assert.ok(phasesVisited.has(p), `phase ${p} never visited\n${table.dump()}`);
            }

            // 3. Every living, entitled player performed their actions.
            assert.ok(stats.votes > 0, 'no votes were cast');
            assert.ok(stats.draws > 0 && stats.discards > 0 && stats.receives > 0 && stats.enacts > 0,
              `legislative actions incomplete: ${JSON.stringify(stats)}`);

            // 4. No transport errors, no invariant violations.
            assert.deepEqual(table.socketErrors, [], `socket errors: ${table.socketErrors.join('; ')}`);
            assert.deepEqual(table.invariantErrors, [], `invariant violations: ${table.invariantErrors.join('; ')}`);

            // 5. Dead players stay excluded in the final public view.
            const v = table.board.view;
            for (const p of v.players) {
              if (!p.alive) {
                assert.ok(!p.isPresident && !p.isChancellor && !p.isNominatedChancellor,
                  `dead player ${p.id} still holds a board role`);
              }
            }
            assert.ok(stats.steps > 0);
            return { winner };
          } finally {
            await table.dispose();
          }
        });
      }
    });
  }
});
