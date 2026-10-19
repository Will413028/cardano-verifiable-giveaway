import { applyD1Migrations, env } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}
// Each test file starts from the committed schema; migrations already applied are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
