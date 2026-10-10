import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, Logger, Match, ROOM, ROTATION, type ArenaChoice, type LogEntry } from '../src';

beforeAll(() => initPhysics());

const SHORT = { lengthTicks: 600, killTarget: 1, resultsTicks: 30 };

function makeMatch(arenas: ArenaChoice, first: string | null = null, seed = 7) {
  const log: LogEntry[] = [];
  const match = new Match(new Logger('test', (e) => void log.push(e)), ROTATION, 2, SHORT, { arenas, first, seed });
  match.join('a');
  match.join('b');
  return { match, log };
}

/** Ends the match now (a reaches the target). */
function endNow(match: Match): void {
  match.world.playerStats('a').score = 1;
  expect(match.step()).toBe('ended');
}

/** Through the results to the next match's first tick. */
function nextMatch(match: Match): void {
  for (let i = 0; i < SHORT.resultsTicks + 2 && match.info.phase === 'results'; i++) match.step();
  expect(match.info.phase).toBe('playing');
}

describe('M2 arena choice', () => {
  it('rotation: the fixed order, the next one named on the results', () => {
    const { match } = makeMatch('rotation');
    const seen = [match.info.arena];
    for (let i = 0; i < ROTATION.length; i++) {
      expect(match.info.next).toBe(ROTATION[(i + 1) % ROTATION.length].name);
      endNow(match);
      nextMatch(match);
      seen.push(match.info.arena);
    }
    expect(seen).toEqual([...ROTATION, ROTATION[0]].map((a) => a.id));
    match.dispose();
  });

  it('one arena: always the same', () => {
    const { match } = makeMatch('one', 'frozen_lake');
    for (let i = 0; i < 3; i++) {
      expect(match.info.arena).toBe('frozen_lake');
      expect(match.info.next).toBe(match.info.arenaName);
      endNow(match);
      nextMatch(match);
    }
    match.dispose();
  });

  it('random: a shuffle bag: every arena once before any repeats, never the same twice in a row', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { match } = makeMatch('random', null, seed);
      const seen = [match.info.arena];
      for (let i = 0; i < ROTATION.length * 2; i++) {
        endNow(match);
        nextMatch(match);
        seen.push(match.info.arena);
      }
      expect(new Set(seen.slice(0, ROTATION.length)).size).toBe(ROTATION.length);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
      match.dispose();
    }
  });

  it('vote: 3 options on the results screen (not the arena just played); the most votes wins', () => {
    const { match, log } = makeMatch('vote');
    expect(match.info.next).toBeNull();
    expect(match.vote('a', 'backyard')).toBe('no_vote_now'); // (only on the results screen)
    endNow(match);
    const v = match.info.vote!;
    expect(v.options).toHaveLength(ROOM.voteOptions);
    expect(new Set(v.options.map((o) => o.id)).size).toBe(ROOM.voteOptions);
    expect(v.options.map((o) => o.id)).not.toContain(match.info.arena);
    const [x, y] = v.options.map((o) => o.id);
    expect(match.vote('a', 'not_an_arena')).toBe('not_an_option');
    expect(match.vote('ghost', x)).toBe('not_a_player');
    expect(match.vote('a', y)).toBeNull();
    expect(match.vote('a', x)).toBeNull(); // changed their mind
    expect(match.vote('a', x)).toBe('same_vote');
    expect(match.vote('b', x)).toBeNull();
    expect(match.info.vote!.votes).toEqual({ a: x, b: x });
    nextMatch(match);
    expect(match.info.arena).toBe(x);
    expect(match.info.vote).toBeNull();
    expect(log.find((e) => e.ev === 'arena_pick')).toMatchObject({ how: 'vote', picked: x, voters: 2 });
    match.dispose();
  });

  it('vote: nobody votes -> a random option; a tie -> one of the tied; a leaver\'s vote goes', () => {
    const picks = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { match, log } = makeMatch('vote', null, seed);
      endNow(match);
      const options = match.info.vote!.options.map((o) => o.id);
      nextMatch(match);
      expect(options).toContain(match.info.arena);
      expect(log.find((e) => e.ev === 'arena_pick')?.how).toBe('random_no_votes');
      picks.add(String(options.indexOf(match.info.arena)));
      match.dispose();
    }
    expect(picks.size).toBeGreaterThan(1); // (not always the first option)

    const { match, log } = makeMatch('vote');
    match.join('c');
    endNow(match);
    const [x, y] = match.info.vote!.options.map((o) => o.id);
    match.vote('a', x);
    match.vote('b', y);
    match.vote('c', y);
    match.leave('c');
    expect(match.info.vote!.votes).toEqual({ a: x, b: y });
    nextMatch(match);
    expect([x, y]).toContain(match.info.arena);
    expect(log.find((e) => e.ev === 'arena_pick')?.how).toBe('vote_tie');
    match.dispose();
  });
});
