// Standalone server for the factual investigation engine: migrations, HTTP API and the step-job worker loop.
// Env: DATABASE_URL, PORT (default 8108), HOST (default 127.0.0.1), IDENTITY_PUBLIC_KEYS (JSON map kid→PEM) or
// IDENTITY_JWKS_FILE (JSON file with the same map), IDENTITY_ISSUER (optional), OBJECT_STORE* (optional, package copies),
// INVESTIGATION_REQUIRE_DISTINCT_REVIEWER (default true), INVESTIGATION_WORKER_INTERVAL_MS (default 1000).
// Standalone, no collaborator ports are configured: port-backed steps record the outcome `unavailable`.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createHttpHandler, createTokenVerifier, objectStoreFromEnv, pgSql, serve } from '../service-kit.ts';
import { createEngine, manifest, migrate, routes } from './index.ts';

async function main(): Promise<void> {
  const env = process.env;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const keysJson = env.IDENTITY_PUBLIC_KEYS ?? (env.IDENTITY_JWKS_FILE ? await readFile(env.IDENTITY_JWKS_FILE, 'utf8') : undefined);
  if (keysJson === undefined) throw new Error('IDENTITY_PUBLIC_KEYS or IDENTITY_JWKS_FILE is required: the server never runs without token verification');
  const publicKeys = JSON.parse(keysJson) as Record<string, string>;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  const sql = pgSql(pool);
  await migrate(sql);
  const engine = createEngine({
    sql,
    ...(env.OBJECT_STORE !== undefined || env.OBJECT_STORE_PATH !== undefined ? { objects: objectStoreFromEnv(env, './data/objects') } : {}),
    config: { requireDistinctReviewer: env.INVESTIGATION_REQUIRE_DISTINCT_REVIEWER !== 'false' },
  });
  const handler = createHttpHandler({
    name: manifest.name, version: manifest.version, routes: routes(engine), health: () => engine.health(),
    verify: createTokenVerifier({ publicKeys, ...(env.IDENTITY_ISSUER ? { issuer: env.IDENTITY_ISSUER } : {}) }),
    onError: (error, info) => console.error(JSON.stringify({ level: 'error', requestId: info.requestId, method: info.method, path: info.path, error: error instanceof Error ? error.name : 'error' })),
  });
  const server = await serve(handler, Number(env.PORT ?? 8108), env.HOST ?? '127.0.0.1');
  const worker = `investigation-${randomUUID()}`;
  let stopping = false;
  const loop = async (): Promise<void> => {
    while (!stopping) {
      try { if (await engine.runJobs({ worker }) === 0) await new Promise((r) => setTimeout(r, Number(env.INVESTIGATION_WORKER_INTERVAL_MS ?? 1000))); }
      catch (error) { console.error(JSON.stringify({ level: 'error', worker, error: error instanceof Error ? error.name : 'error' })); await new Promise((r) => setTimeout(r, 5000)); }
    }
  };
  const done = loop();
  console.log(JSON.stringify({ level: 'info', message: 'factual investigation engine listening', address: server.address() }));
  const stop = (): void => { stopping = true; server.close(); void done.then(() => pool.end()).then(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'startup failed'); process.exit(1); });
