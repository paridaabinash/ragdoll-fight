import { AWARD_NAMES, MODIFIER_NAMES, modifierOn, PHYSICS_HZ, type Award, type BestMoment, type MatchInfo } from '@ragdoll/shared';

const clock = (ticks: number): string => {
  const secs = Math.max(0, Math.ceil(ticks / PHYSICS_HZ));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};
const secs = (ticks: number): number => Math.max(0, Math.ceil(ticks / PHYSICS_HZ));

/** One HUD line: which match, where, time left, score target. */
export function matchLine(m: MatchInfo, tick: number): string {
  const where = `Match ${m.number} · ${m.arenaName}${m.size === 'narrow' ? ' (small)' : ''}`;
  if (m.phase === 'results') return `${where} · over`;
  return `${where} · ${clock(m.endTick - tick)} left · first to ${m.killTarget} points (crown kill = 2)`;
}

/** The chaos round, as big text at the top of the screen: "MOON GRAVITY in 3" while announced, "... 14s left" while on. */
export function modifierHeadline(m: MatchInfo, tick: number): string | null {
  const c = m.modifier;
  if (!c || m.phase !== 'playing' || tick >= c.end) return null;
  const name = MODIFIER_NAMES[c.kind];
  return modifierOn(c, tick) ? `${name}  ${secs(c.end - tick)}s left` : `CHAOS ROUND: ${name} in ${secs(c.start - tick)}`;
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

/** The results panel (null while playing): winner, scores, awards, best moment, next arena countdown. */
export function matchBanner(m: MatchInfo, tick: number, nameOf: (id: string) => string): string[] | null {
  if (m.phase !== 'results' || !m.result) return null;
  const r = m.result;
  const top = r.scores[0];
  const title = r.winner ? `${nameOf(r.winner)} wins!` : 'Draw!';
  const why = r.reason === 'kills' ? `first to ${m.killTarget} points` : "time's up";
  return [
    title,
    `(${why}${r.winner && top ? `, ${top.score} points` : ''})`,
    '',
    ...r.scores.slice(0, 8).map((s, i) => `${i + 1}. ${nameOf(s.id).padEnd(16)} ${String(s.score).padStart(2)} pts  ${String(s.kills).padStart(2)} kills  ${String(s.deaths).padStart(2)} deaths`),
    ...(r.awards.length ? ['', 'AWARDS', ...r.awards.map((a) => awardLine(a, nameOf))] : []),
    ...(r.best ? ['', `Best moment: ${bestMomentLabel(r.best, nameOf)}`] : []),
    '',
    `Next: ${m.next} in ${clock((m.resultsUntil ?? tick) - tick)}`,
  ];
}
