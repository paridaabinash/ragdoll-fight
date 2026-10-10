import type { ArenaDef } from '../arena';
import { BACKYARD } from './backyard';
import { CONSTRUCTION_SITE } from './construction-site';
import { FROZEN_LAKE } from './frozen-lake';
import { TEST_LAB } from './test-lab';
import { WINDY_ROOFTOP } from './windy-rooftop';

export { BACKYARD, CONSTRUCTION_SITE, FROZEN_LAKE, TEST_LAB, WINDY_ROOFTOP };

/** Every arena, by id. A new arena = a new file + one line here; tests, sim and netsim then check it automatically. */
export const ARENAS: Record<string, ArenaDef> = {
  [BACKYARD.id]: BACKYARD,
  [TEST_LAB.id]: TEST_LAB,
  [WINDY_ROOFTOP.id]: WINDY_ROOFTOP,
  [CONSTRUCTION_SITE.id]: CONSTRUCTION_SITE,
  [FROZEN_LAKE.id]: FROZEN_LAKE,
};

/**
 * The fixed order matches go through (L6: the final arenas, then the two placeholders, kept by choice; L7: Frozen Lake,
 * the aurora arena, after the rooftop). The server starts with the first one.
 */
export const ROTATION: ArenaDef[] = [WINDY_ROOFTOP, FROZEN_LAKE, CONSTRUCTION_SITE, TEST_LAB, BACKYARD];

export function arenaById(id: string): ArenaDef | undefined {
  return Object.hasOwn(ARENAS, id) ? ARENAS[id] : undefined;
}
