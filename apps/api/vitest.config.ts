import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the bindings declared in wrangler.jsonc: D1 and R2 are Miniflare's local
// implementations (SQLite and its object store), not fakes. The D1 migrations are applied by test/setup.ts.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // NONCE_KEY: a test value for the owner-operation nonce MAC (a Worker secret when deployed; apps/api/src/auth.ts).
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          NONCE_KEY: 'test-nonce-key-for-workerd-tests-only-0123456789',
        },
      },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
}));
