// Pure rule constants for Secret Hitler (verified against the official free PDF).
// 5–10 players. Roles per count: 5–6 → 1 Fascist + Hitler; 7–8 → 2 + Hitler; 9–10 → 3 + Hitler.
// Deck: 6 Liberal / 11 Fascist tiles. Powers per board below. Veto unlocks after 5 fascist policies.

export const ROLE = {
  LIBERAL: 'liberal',
  FASCIST: 'fascist',
  HITLER: 'hitler',
};

export const PARTY = {
  LIBERAL: 'liberal',
  FASCIST: 'fascist',
};

export const POLICY = {
  LIBERAL: 'liberal',
  FASCIST: 'fascist',
};

export const PHASE = {
  LOBBY: 'LOBBY',
  ROLE_REVEAL: 'ROLE_REVEAL',
  NOMINATION: 'NOMINATION',
  VOTE: 'VOTE',
  LEGISLATIVE_PRESIDENT: 'LEGISLATIVE_PRESIDENT',
  LEGISLATIVE_CHANCELLOR: 'LEGISLATIVE_CHANCELLOR',
  EXEC_ACTION: 'EXEC_ACTION',
  GAME_OVER: 'GAME_OVER',
};

export const VOTE = { JA: 'ja', NEIN: 'nein' };

export const POWER = {
  INVESTIGATE: 'investigate',
  SPECIAL_ELECTION: 'specialElection',
  POLICY_PEEK: 'policyPeek',
  EXECUTE: 'execute',
};

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;

export const FASCISTS_PER_COUNT = { 5: 1, 6: 1, 7: 2, 8: 2, 9: 3, 10: 3 };

export const DECK_LIBERAL = 6;
export const DECK_FASCIST = 11;

export const DRAW_SIZE = 3; // president draws 3; policy peek shows 3
export const ELECTION_TRACKER_MAX = 3;
export const VETO_UNLOCK_FASCIST = 5;
export const HITLER_CHANCELLOR_FASCIST_MIN = 3;
export const LIBERAL_WIN_COUNT = 5;
export const FASCIST_WIN_COUNT = 6;

// Fascist board powers by player count, keyed by enacted fascist policies.
export const POWERS_BY_PLAYER_COUNT = {
  5: { 3: POWER.POLICY_PEEK, 4: POWER.EXECUTE, 5: POWER.EXECUTE },
  6: { 3: POWER.POLICY_PEEK, 4: POWER.EXECUTE, 5: POWER.EXECUTE },
  7: { 2: POWER.INVESTIGATE, 3: POWER.SPECIAL_ELECTION, 4: POWER.EXECUTE, 5: POWER.EXECUTE },
  8: { 2: POWER.INVESTIGATE, 3: POWER.SPECIAL_ELECTION, 4: POWER.EXECUTE, 5: POWER.EXECUTE },
  9: { 1: POWER.INVESTIGATE, 2: POWER.INVESTIGATE, 3: POWER.SPECIAL_ELECTION, 4: POWER.EXECUTE, 5: POWER.EXECUTE },
  10: { 1: POWER.INVESTIGATE, 2: POWER.INVESTIGATE, 3: POWER.SPECIAL_ELECTION, 4: POWER.EXECUTE, 5: POWER.EXECUTE },
};

export function powerForCount(playerCount, fascistPolicies) {
  const table = POWERS_BY_PLAYER_COUNT[playerCount];
  if (!table) return null;
  return table[fascistPolicies] ?? null;
}
