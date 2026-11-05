import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Every suite opens real emulator connections, so the defaults are too tight.
    hookTimeout: 60_000,
    testTimeout: 20_000,
    // Rules tests mutate shared emulator state; running files in sequence keeps
    // a denial from being attributed to another suite's write.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
