import { AWARD_NAMES, MODES, MODIFIER_NAMES, modifierOn, PHYSICS_HZ, TEAM_NAMES, type Award, type BestMoment, type MatchInfo } from '@ragdoll/shared';

const clock = (ticks: number): string => {
  const secs = Math.max(0, Math.ceil(ticks / PHYSICS_HZ));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};
const secs = (ticks: number): number => Math.max(0, Math.ceil(ticks / PHYSICS_HZ));

/** How long "ROUND 3 - FIGHT!" stays up at a round's start (ticks). */
const ROUND_START_TICKS = 90;

/** L7: the quiet line at the top center: (M3) the mode or the team score, where, time left, the target. */
export function matchTop(m: MatchInfo, tick: number): string {
  if (m.phase === 'results') return `${m.arenaName} · over`;
  const mode = MODES[m.mode];
  const target = `first to ${m.killTarget} ${mode.unit}`;
  if (m.teamScores) return `${TEAM_NAMES[0].toUpperCase()} ${m.teamScores[0]} - ${m.teamScores[1]} ${TEAM_NAMES[1].toUpperCase()} · ${clock(m.endTick - tick)} · ${target}`;
  if (m.round) return `${mode.name} · round ${m.round.number} · ${clock(m.endTick - tick)} · ${target}`;
  return `${mode.name} · ${m.arenaName} · ${clock(m.endTick - tick)} · ${target}`;
}

/** The chaos round, as big text at the top of the screen: "MOON GRAVITY in 3" while announced, "... 14s left" while on. */
export function modifierHeadline(m: MatchInfo, tick: number): string | null {
  const c = m.modifier;
  if (!c || m.phase !== 'playing' || tick >= c.end) return null;
  const name = MODIFIER_NAMES[c.kind];
  return modifierOn(c, tick) ? `${name}  ${secs(c.end - tick)}s left` : `CHAOS ROUND: ${name} in ${secs(c.start - tick)}`;
}

/** M3 Last Standing: "ROUND 2: BOB WINS IT!" in the pause, "ROUND 3 - FIGHT!" as the next one starts. */
export function roundHeadline(m: MatchInfo, tick: number, nameOf: (id: string) => string): string | null {
  const r = m.round;
  if (!r || m.phase !== 'playing') return null;
  if (r.phase === 'over') return `ROUND ${r.number}: ${r.winner ? `${nameOf(r.winner).toUpperCase()} WINS IT!` : 'NOBODY WINS IT'}  (next in ${secs((r.until ?? tick) - tick)})`;
  if (r.number > 1 && tick - r.startTick < ROUND_START_TICKS) return `ROUND ${r.number} - FIGHT!`;
  return null;
}

const BEST_NAMES: Record<string, string> = { ring_out: 'RING OUT', double_kill: 'DOUBLE KILL', self_own: 'SELF-OWN', outta_here: 'OUTTA HERE' };

/** "RING OUT! Bob on Ann": the label of the best moment. */
export function bestMomentLabel(b: BestMoment, nameOf: (id: string) => string): string {
  const what = `${BEST_NAMES[b.kind] ?? b.kind.replace(/_/g, ' ').toUpperCase()}!`;
  if (!b.by || b.by === b.id) return `${what} ${nameOf(b.id)}`;
  return `${what} ${nameOf(b.by)} on ${nameOf(b.id)}`;
}

function awardLine(a: Award, nameOf: (id: string) => string): string {
  const v = a.kind === 'longest_shot' ? `${a.value} m` : a.kind === 'crown_holder' ? `${a.value} s` : `${a.value}`;
  return `${AWARD_NAMES[a.kind].padEnd(17)} ${nameOf(a.id)} (${v})`;
}

/** Short score unit for the results table. */
const SCORE_UNIT: Record<string, string> = { points: 'pts', 'crown seconds': 'sec', 'round wins': 'wins', 'team kills': 'pts' };

/** The results panel (null while playing): winner, scores, awards, best moment, next arena (or the vote) countdown. */
export function matchBanner(m: MatchInfo, tick: number, nameOf: (id: string) => string): string[] | null {
  if (m.phase !== 'results' || !m.result) return null;
  const r = m.result;
  const mode = MODES[m.mode];
  const top = r.scores[0];
  const unit = SCORE_UNIT[mode.unit] ?? 'pts';
  const title = m.teamScores ? (r.winnerTeam !== null ? `${TEAM_NAMES[r.winnerTeam].toUpperCase()} TEAM wins!` : 'Draw!') : r.winner ? `${nameOf(r.winner)} wins!` : 'Draw!';
  const why = r.reason === 'kills' ? `first to ${m.killTarget} ${mode.unit}` : "time's up";
  const detail = m.teamScores ? `, ${TEAM_NAMES[0]} ${m.teamScores[0]} - ${m.teamScores[1]} ${TEAM_NAMES[1]}` : r.winner && top ? `, ${top.score} ${unit}` : '';
  const next = m.vote ? `Vote for the next arena below (keys 1-${m.vote.options.length}) · ${clock((m.resultsUntil ?? tick) - tick)}` : `Next: ${m.next ?? '?'} in ${clock((m.resultsUntil ?? tick) - tick)}`;
  return [
    title,
    `(${mode.name}: ${why}${detail})`,
    '',
    ...r.scores.slice(0, 8).map((s, i) => `${i + 1}. ${nameOf(s.id).padEnd(16)} ${String(s.score).padStart(3)} ${unit.padEnd(4)} ${String(s.kills).padStart(2)} kills  ${String(s.deaths).padStart(2)} deaths`),
    ...(r.awards.length ? ['', 'AWARDS', ...r.awards.map((a) => awardLine(a, nameOf))] : []),
    ...(r.best ? ['', `Best moment: ${bestMomentLabel(r.best, nameOf)}`] : []),
    '',
    next,
  ];
}
