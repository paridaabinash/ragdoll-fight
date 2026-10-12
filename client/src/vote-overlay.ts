import { PHYSICS_HZ, type Logger, type MatchInfo } from '@ragdoll/shared';
import { arenaThumb } from './menu/arena-thumb';
import { freePointer } from './game-menu';

/**
 * M2: the arena vote on the results screen: the options as cards (picture from the arena data, name, votes so far),
 * your pick lit up, the leader marked. Click a card or press 1-3. The server checks every vote and tells everyone the
 * counts in the match info, so this only draws what it says.
 */
export class VoteOverlay {
  private readonly root = document.getElementById('vote')!;
  private key = '';
  private shownFor = -1;

  constructor(
    private readonly log: Logger,
    private readonly send: (arena: string) => void,
  ) {}

  /** `m`: the newest match info (votes arrive there); `me`: my player id; `tick`: the server's now. */
  update(m: MatchInfo, me: string, tick: number): void {
    const v = m.phase === 'results' ? m.vote : null;
    if (!v) {
      if (!this.root.hidden) this.root.hidden = true;
      this.key = '';
      return;
    }
    if (this.shownFor !== m.number) {
      this.shownFor = m.number;
      // the mouse is locked to the game while playing: free it so the cards can be clicked
      freePointer(); // (without opening the in-game menu)
      this.log.info('vote_shown', { match: m.number, options: v.options.map((o) => o.id) });
    }
    const left = Math.max(0, Math.ceil(((m.resultsUntil ?? tick) - tick) / PHYSICS_HZ));
    const mine = v.votes[me] ?? null;
    const counts = v.options.map((o) => Object.values(v.votes).filter((a) => a === o.id).length);
    const key = JSON.stringify([v.options, counts, mine, left]);
    if (key === this.key) return;
    this.key = key;
    const most = Math.max(...counts);
    const head = document.createElement('div');
    head.className = 'vote-head';
    head.innerHTML = `<span>Vote for the next arena</span><small>${mine ? 'You can still change it' : 'Nobody votes: a random one'} · ${left}s</small>`;
    const cards = document.createElement('div');
    cards.className = 'vote-cards';
    v.options.forEach((o, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `vote-card${o.id === mine ? ' mine' : ''}${most > 0 && counts[i] === most ? ' lead' : ''}`;
      card.innerHTML = `<img alt="" src="${arenaThumb(o.id)}"><span class="key">${i + 1}</span><span class="label"><span>${o.name}</span><span class="count">${'●'.repeat(counts[i]) || '-'}</span></span>`;
      card.onclick = () => this.pick(o.id);
      cards.append(card);
    });
    this.root.replaceChildren(head, cards);
    this.root.hidden = false;
  }

  /** Keys 1-3 (from the game scene). */
  pickIndex(m: MatchInfo, i: number): void {
    const o = m.phase === 'results' ? m.vote?.options[i] : undefined;
    if (o) this.pick(o.id);
  }

  private pick(arena: string): void {
    this.send(arena);
  }

  destroy(): void {
    this.root.hidden = true;
    this.root.replaceChildren();
  }
}
