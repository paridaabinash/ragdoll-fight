import { MODE } from './constants';
import type { GameMode } from './room-settings';
import type { ModifierKind } from './spice';

/**
 * M3: what each game mode changes. `Match` applies it to every world it builds (crown rule, respawns, starting weapon,
 * pickups, teams) and to its own loop (target, rounds, chaos rounds). Everything else is the normal game.
 */
export interface ModeRules {
  name: string;
  /** One line for the menus. */
  blurb: string;
  /** The score that ends a match early. */
  target: number;
  /** What the score counts (HUD: "first to 60 crown seconds"). */
  unit: string;
  /** `bounty`: the leader wears it, killing them is worth more (S7). `keeper`: points while you hold it. `off`: none. */
  crown: 'bounty' | 'keeper' | 'off';
  /** A kill adds to the killer's score (1, or more for the crown holder). False: the score counts something else. */
  killsScore: boolean;
  /** False: dead players stay dead until the next round (Last Standing). */
  respawn: boolean;
  /** Rounds inside a match (Last Standing): a round ends when one player is left. */
  rounds: boolean;
  /** Everyone starts with a bat or mace instead of the gun. */
  weapon: 'gun' | 'melee';
  /** Power-up bubbles in the arena (they're shot, so no use without guns). */
  pickups: boolean;
  /** Two teams; no damage to teammates. */
  teams: boolean;
  /** Chaos rounds: how often and how long, as shares of `MODIFIER` (0 = none), and kinds left out. */
  chaosEvery: number;
  chaosLength: number;
  chaosSkip: ModifierKind[];
}

export const MODES: Record<GameMode, ModeRules> = {
  ffa: {
    name: 'Free-for-all',
    blurb: 'Everyone against everyone. Kill the crown holder for 2 points.',
    target: MODE.ffaTarget,
    unit: 'points',
    crown: 'bounty',
    killsScore: true,
    respawn: true,
    rounds: false,
    weapon: 'gun',
    pickups: true,
    teams: false,
    chaosEvery: 1,
    chaosLength: 1,
    chaosSkip: [],
  },
  crown: {
    name: 'Crown Keeper',
    blurb: 'Grab the crown with a kill, then keep it alive. 1 point a second.',
    target: MODE.crownTarget,
    unit: 'crown seconds',
    crown: 'keeper',
    killsScore: false,
    respawn: true,
    rounds: false,
    weapon: 'gun',
    pickups: true,
    teams: false,
    chaosEvery: 1,
    chaosLength: 1,
    chaosSkip: [],
  },
  last_standing: {
    name: 'Last Ragdoll Standing',
    blurb: 'No respawns. Last one alive wins the round.',
    target: MODE.roundsTarget,
    unit: 'round wins',
    crown: 'off',
    killsScore: false,
    respawn: false,
    rounds: true,
    weapon: 'gun',
    pickups: true,
    teams: false,
    chaosEvery: 0,
    chaosLength: 0,
    chaosSkip: [],
  },
  melee: {
    name: 'Melee Mayhem',
    blurb: 'No guns. Bats and maces only.',
    target: MODE.meleeTarget,
    unit: 'points',
    crown: 'bounty',
    killsScore: true,
    respawn: true,
    rounds: false,
    weapon: 'melee',
    pickups: false,
    teams: false,
    chaosEvery: 1,
    chaosLength: 1,
    // (every shot a glove: there are no shots)
    chaosSkip: ['glove_only'],
  },
  chaos: {
    name: 'Chaos',
    blurb: 'A chaos round almost all the time: moon gravity, big heads, oil...',
    target: MODE.chaosTarget,
    unit: 'points',
    crown: 'bounty',
    killsScore: true,
    respawn: true,
    rounds: false,
    weapon: 'gun',
    pickups: true,
    teams: false,
    chaosEvery: MODE.chaosEveryScale,
    chaosLength: MODE.chaosLengthScale,
    chaosSkip: [],
  },
  teams: {
    name: 'Team Battle',
    blurb: 'Red against blue. Teammates can\'t hurt each other.',
    target: MODE.teamTarget,
    unit: 'team kills',
    crown: 'off',
    killsScore: true,
    respawn: true,
    rounds: false,
    weapon: 'gun',
    pickups: true,
    teams: true,
    chaosEvery: 1,
    chaosLength: 1,
    chaosSkip: [],
  },
};

export type Team = 0 | 1;
export const TEAM_NAMES: Record<Team, string> = { 0: 'Red', 1: 'Blue' };
