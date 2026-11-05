// Online game simulator: N in-page virtual "phones" that drive COMPLETE
// random Secret Hitler games through the REAL browser-hosted GameRoom.
//
// Activation: board/?bots=N[&games=G] (N = 5..10). board.js dynamically
// imports this module ONLY when the ?bots= param is present, so normal
// players never download or run it.
//
// What this exercises (in the real static-host environment):
//   - the actual GameSession + GameRoom the board page hosts online,
//   - the byte-identical handlePlay('join'/'action') protocol a real PeerJS
//     phone triggers (host.js routes every incoming P2P message here),
//   - full engine behavior: elections, legislative chain, veto, all executive
//     powers, chaos, reshuffles, every win condition,
//   - live board UI re-rendering on every broadcast (the loopback socket).
//
// The Node driver (scripts/simulate-online.mjs) launches this page in
// headless Chrome, waits for window.__sim, then re-verifies every finished
// game's public event log with the same strict verifier the offline bot
// tests use (tests/bots/driver.js → verifyLogHistory).
import { PHASE, POWER, VOTE } from '../server/engine/index.js';

const MAX_STEPS = 3000;
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

// One virtual phone: a room client exactly like the ones host.js creates for
// incoming PeerJS DataConnections. send() records pushed views for debugging.
function makeBotClient(name) {
  const client = {
    kind: 'play',
    authToken: null,
    data: { name },
    send(event, payload) {
      if (event === 'state') client.data.view = payload;
      if (event === 'hello') client.data.hello = payload;
    },
  };
  return client;
}

// Random-but-legal decision helpers (mirror tests/bots/driver.js defaults).
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export async function runBots({ room, session }, n, games = 1) {
  const sim = (window.__sim = {
    done: false, total: games, progress: 0, results: [], error: null,
    phase: '', startedAt: Date.now(),
  });

  // A synthetic board client for board:* control events (start/reset) —
  // handleBoard does not use the client reference; broadcasts to it are no-ops.
  const boardClient = { kind: 'board', authToken: null, data: {}, send: () => {} };

  // Create the phone clients and (re)seat them. On the first game they join a
  // fresh lobby; after each game a reset invalidates tokens, so every game
  // starts with a join pass (exactly what real players do after a reset).
  const bots = Array.from({ length: n }, (_, i) => makeBotClient(`Bot${i + 1}`));
  for (const b of bots) room.addClient(b);
  const joinAll = () => {
    for (const b of bots) {
      const ack = room.handlePlay(b, 'join', { name: b.data.name });
      if (!ack?.ok) throw new Error(`join failed for ${b.data.name}: ${JSON.stringify(ack)}`);
      b.authToken = ack.token;
      b.data.token = ack.token;
      b.data.playerId = ack.playerId;
    }
  };

  const aliveBots = (view) => view.players.filter((p) => p.alive)
    .map((p) => bots.find((b) => b.data.playerId === p.id))
    .filter(Boolean);
  const botOf = (id) => bots.find((b) => b.data.playerId === id);

  const act = (bot, type, args = {}) => {
    const ack = room.handlePlay(bot, 'action', { type, ...args });
    if (!ack?.ok) throw new Error(`${type} failed for ${bot.data.name}: ${JSON.stringify(ack)}`);
    return ack;
  };

  for (let g = 0; g < games; g++) {
    if (g > 0) {
      const resetAck = room.handleBoard(boardClient, 'board:reset', {});
      if (!resetAck?.ok) throw new Error(`board:reset failed: ${JSON.stringify(resetAck)}`);
    }
    joinAll();
    const startAck = room.handleBoard(boardClient, 'board:start', {});
    if (!startAck?.ok) throw new Error(`board:start failed: ${JSON.stringify(startAck)}`);

    const t0 = Date.now();
    let steps = 0;

    for (; steps < MAX_STEPS; steps++) {
      await yieldToUi(); // keep the page (and board re-renders) responsive
      const v = session.publicState();
      sim.phase = `${g + 1}/${games}: ${v.phase}`;

      if (v.phase === PHASE.GAME_OVER) {
        sim.results.push({
          game: g + 1,
          playerCount: v.playerCount,
          winner: v.winner,
          winReason: v.winReason,
          liberalCount: v.liberalCount,
          fascistCount: v.fascistCount,
          steps,
          events: v.log.length,
          ms: Date.now() - t0,
          log: v.log,
          players: v.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive })),
        });
        sim.progress = g + 1;
        break;
      }

      switch (v.phase) {
        case PHASE.ROLE_REVEAL: {
          const ack = room.handleBoard(boardClient, 'board:beginNomination', {});
          if (!ack?.ok) throw new Error(`beginNomination failed: ${JSON.stringify(ack)}`);
          break;
        }

        case PHASE.NOMINATION: {
          const eligible = v.eligibleChancellors ?? [];
          if (!eligible.length) throw new Error(`no eligible chancellors (step ${steps})`);
          act(botOf(v.presidentId), 'nominate', { targetId: pick(eligible) });
          break;
        }

        case PHASE.VOTE: {
          const choice = Math.random() < 0.6 ? VOTE.JA : VOTE.NEIN;
          for (const bot of aliveBots(v)) {
            // The election may fully resolve mid-pass (the deciding vote);
            // the room tolerates late votes with a structured error, and we
            // simply stop once the phase moved on.
            if (session.publicState().phase !== PHASE.VOTE) break;
            const ack = room.handlePlay(bot, 'action', { type: 'vote', vote: choice });
            if (!ack?.ok) {
              const lv = session.publicState().lastVote;
              if (!(session.publicState().phase !== PHASE.VOTE && lv?.votes?.[bot.data.playerId] !== undefined)) {
                throw new Error(`vote failed for ${bot.data.name}: ${JSON.stringify(ack)}`);
              }
            }
          }
          break;
        }

        case PHASE.LEGISLATIVE_PRESIDENT: {
          const pres = botOf(v.presidentId);
          if (v.presidentDrew) break; // wait for the phase to advance
          // Plain tap draw (no QR token) — the primary phone path.
          act(pres, 'draw');
          const you = session.privateState(v.presidentId);
          if (!Array.isArray(you.hand) || you.hand.length !== 3) {
            throw new Error(`president hand missing after draw: ${JSON.stringify(you)}`);
          }
          act(pres, 'discard', { cardIndex: Math.floor(Math.random() * 3) });
          break;
        }

        case PHASE.LEGISLATIVE_CHANCELLOR: {
          const chan = botOf(v.chancellorId);
          if (v.vetoRequested) {
            act(botOf(v.presidentId), 'vetoRespond', { consent: Math.random() < 0.5 });
            break;
          }
          if (v.transferPending) {
            const ack = act(chan, 'receive');
            chan.data.hand = ack.you?.chancellorHand ?? null;
            break;
          }
          const hand = chan.data.hand ?? session.privateState(v.chancellorId).chancellorHand;
          if (!Array.isArray(hand) || hand.length !== 2) break; // delivery still in flight
          if (v.vetoUnlocked && Math.random() < 0.05) {
            act(chan, 'vetoRequest');
            break;
          }
          act(chan, 'enact', { cardIndex: Math.floor(Math.random() * 2) });
          chan.data.hand = null;
          break;
        }

        case PHASE.EXEC_ACTION: {
          const pres = botOf(v.presidentId);
          const power = v.pendingPower;
          const alive = v.players.filter((p) => p.alive && p.id !== v.presidentId).map((p) => p.id);
          const legal = power === POWER.INVESTIGATE
            ? alive.filter((id) => !v.investigatedIds.includes(id))
            : alive;
          const type = power === POWER.POLICY_PEEK ? 'peek' : power;
          if (type === 'peek') {
            const ack = act(pres, 'peek');
            if (ack.you?.lastPeek?.length !== 3) throw new Error(`peek did not reveal 3 cards: ${JSON.stringify(ack.you)}`);
          } else {
            if (!legal.length) throw new Error(`no legal target for ${power} (step ${steps})`);
            const ack = act(pres, type, { targetId: pick(legal) });
            if (power === POWER.INVESTIGATE && !['liberal', 'fascist'].includes(ack.you?.lastInvestigation?.party)) {
              throw new Error(`bad investigation result: ${JSON.stringify(ack.you)}`);
            }
          }
          // Transparency gate: every living player must ack the announcement.
          let guard = 0;
          while (session.publicState().investigationAnnounce && guard++ < n * 2) {
            for (const bot of aliveBots(session.publicState())) {
              if (!session.publicState().investigationAnnounce) break;
              room.handlePlay(bot, 'action', { type: 'ackInvestigation' });
            }
            await yieldToUi();
          }
          break;
        }

        default:
          throw new Error(`simulator: unexpected phase ${v.phase} (step ${steps})`);
      }
    }

    if (steps >= MAX_STEPS) {
      throw new Error(`game ${g + 1} did not finish within ${MAX_STEPS} steps (phase ${sim.phase})`);
    }
  }

  sim.done = true;
  return sim.results;
}
