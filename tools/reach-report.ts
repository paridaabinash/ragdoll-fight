/**
 * L6: the arena reach check for every arena (and drafts given on the command line), both sizes, whole body and two
 * stumps: `npx tsx tools/reach-report.ts [tools/arena-drafts/<name>.ts ...]`.
 */
import { ARENAS, arenaLayout, arenaReach, describeSurface, type ArenaDef } from '../shared/src';

const defs: ArenaDef[] = [...Object.values(ARENAS)];
for (const file of process.argv.slice(2)) {
  const mod = (await import(new URL(`../${file}`, import.meta.url).href)) as Record<string, ArenaDef>;
  defs.push(...Object.values(mod).filter((v) => v && typeof v === 'object' && 'solids' in v));
}
let bad = 0;
for (const def of defs) {
  for (const size of def.narrow ? (['narrow', 'full'] as const) : (['full'] as const)) {
    const l = arenaLayout(def, size);
    const whole = arenaReach(l, 'whole');
    const stumps = arenaReach(l, 'stumps');
    const problems = whole.unreachable.length + whole.traps.length + whole.blockedTrampolines.length;
    bad += problems;
    console.log(`${def.id}/${size}: ${whole.surfaces.length} places, unreachable ${whole.unreachable.length}, traps ${whole.traps.length}, trampolines blocked ${whole.blockedTrampolines.length}; on two stumps ${stumps.unreachable.length} out of reach`);
    for (const s of whole.unreachable) console.log(`  UNREACHABLE ${describeSurface(s)}`);
    for (const s of whole.traps) console.log(`  TRAP (no way back) ${describeSurface(s)}`);
    for (const t of whole.blockedTrampolines) console.log(`  TRAMPOLINE ${t.label} throws ${t.launch} m up into ${t.by} (${t.room} m above)`);
    for (const s of stumps.unreachable) console.log(`  stumps can't reach ${describeSurface(s)}`);
  }
}
process.exit(bad ? 1 : 0);
