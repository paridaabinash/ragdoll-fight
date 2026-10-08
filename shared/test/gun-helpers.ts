import { STAMINA, type Aim, type Arrow, type GameWorld } from '../src';

/**
 * Test helper (L3): fires with the gun ready and full stamina, for tests about flight, hits and effects (not about the
 * reload or stamina: `l3-gun.test.ts` tests those through the real rules). Throws if the shot is refused anyway.
 */
export function shoot(world: GameWorld, id: string, aim: Aim): Arrow {
  const st = world.stats.get(id);
  if (st) {
    st.readyAt = world.tick;
    st.lastShotTick = -Infinity; // (else the "two shots closer than the reload" check rightly complains)
    st.refill(STAMINA.max);
    st.armsDown = false;
  }
  const res = world.fire(id, aim);
  if (!res.arrow) throw new Error(`shot refused: ${res.refused}`);
  return res.arrow;
}
