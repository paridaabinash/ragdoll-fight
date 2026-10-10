import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many tests run seconds of real physics (a few take 3-8 s alone). Their speed depends on the machine and on what
    // else runs (sim / netsim at the same time), not on correctness, so the default 5 s limit made them fail at random.
    testTimeout: 30_000,
    // Other sessions' git worktrees live under .claude/worktrees: their copies of the tests are not this checkout's.
    exclude: ['**/node_modules/**', '.claude/**'],
  },
});
