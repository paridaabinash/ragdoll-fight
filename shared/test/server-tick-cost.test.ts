import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { GameRoom, type Conn } from '../../server/src/room';
import { fileSink } from '../../tools/log-files';
import { initPhysics, memorySink, NET, TEST_LAB, type LogEntry } from '../src';

beforeAll(() => initPhysics());

describe('server tick cost', () => {
  it('a background log file gets every line, in order, without writing during the call', async () => {
    const sink = fileSink('test-background', { background: true });
    for (let i = 0; i < 500; i++) sink({ t: i, src: 'test', lvl: 'info', ev: 'line', n: i } as LogEntry);
    expect(fs.readFileSync(sink.file, 'utf8')).toBe(''); // queued, not written inside the call (that was the stall)
    await sink.flush();
    const lines = fs.readFileSync(sink.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).n);
    expect(lines).toEqual([...Array(500).keys()]);
    fs.rmSync(sink.file);
    fs.rmSync(sink.file.replace('-latest', '-prev'), { force: true });
  });

  it('room_stats splits the tick into bots, world and sends', () => {
    const sink = memorySink();
    const room = new GameRoom('t', sink, () => {}, { rotation: [TEST_LAB] });
    const nobody: Conn = { send() {}, close() {}, bufferedAmount: 0 };
    room.join(nobody, 'person');
    for (let i = 0; i < NET.statsEveryTicks; i++) room.tick();
    const st = sink.entries.find((e) => e.ev === 'room_stats')!;
    expect(st).toBeDefined();
    const parts = Number(st.botsMs) + Number(st.worldMs) + Number(st.netMs);
    expect(Number(st.worldMs)).toBeGreaterThan(0);
    expect(Math.abs(parts - Number(st.stepAvgMs))).toBeLessThan(0.05); // the parts cover the whole tick
    room.close();
  });
});
