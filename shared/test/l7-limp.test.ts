import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestLevel, captureSnapshot, decodeSnapshot, DUMMY_PLAYER, encodeSnapshot, GameWorld, initPhysics, LIMB, Logger, NO_CONTROLS, type LogEntry } from '../src';

beforeAll(() => initPhysics());

function limping() {
  const log: LogEntry[] = [];
  const w = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildTestLevel(w);
  for (let i = 0; i < 60; i++) w.step();
  for (let k = 0; k < 2; k++) {
    w.bodyHit(DUMMY_PLAYER, 'legFrontLower', -1, 'test');
    for (let i = 0; i < 150; i++) w.step();
  }
  return { w, log, p: w.player(DUMMY_PLAYER) };
}

describe('L7: the limp (a dragged, bandaged leg)', () => {
  it('snapshots say which leg drags (clients draw it bandaged, its foot scraping); none once dead', () => {
    const { w } = limping();
    const snapOf = () => decodeSnapshot(encodeSnapshot(captureSnapshot(w, w.movableBodies())))!.players.find((q) => q.slot === w.slotOf(DUMMY_PLAYER))!;
    const before = snapOf();
    expect(before.legStage).toBe(2);
    expect(before.dragLeg).toBe(w.player(DUMMY_PLAYER).mods.dragLeg);
    expect(before.dragLeg).not.toBeNull();
    w.hurt(DUMMY_PLAYER, 'x', 1000, { x: 0, y: 0 });
    w.step();
    expect(snapOf().dragLeg).toBeNull();
  });

  it('walking on it, the good knee dips deep between hops (a heavier limp)', () => {
    const { w, p } = limping();
    const good = p.mods.dragLeg === 'front' ? 'kneeBack' : 'kneeFront';
    let most = 0;
    for (let i = 0; i < 150; i++) {
      w.setControls(DUMMY_PLAYER, { ...NO_CONTROLS, move: -1 });
      w.step();
      if (i > 40) most = Math.max(most, p.jointAngle(good) * p.facing);
    }
    expect(most).toBeGreaterThan(LIMB.oneLegKnee + LIMB.hopDip * 0.5); // (it was ~0.65: the slight one-leg crouch only)
  });
});
