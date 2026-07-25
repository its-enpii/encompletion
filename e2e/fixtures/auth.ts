/**
 * Auth fixture for the e2e suite. Reads the seeder output via env so
 * the test runner can pass them through `docker compose run -e`.
 *
 * The seeder writes its IDs to stdout as a JSON blob. The harness
 * captures that and exports each as E2E_* env vars before invoking
 * the runner. This module just reads them and exposes typed accessors.
 */

export type SeedUser = {
  id: number;
  username: string;
  password: string;
};

export type SeedData = {
  users: {
    admin: SeedUser;
    member: SeedUser;
    embed: SeedUser;
  };
  models: {
    workspace: number;
    sonnet: number;
    haiku: number;
  };
  tenant: { id: string; slug: string };
  tenantApiKey: { id: number; plaintext: string };
  project: { id: number; name: string };
  embedToken: {
    token: string;
    expires_at: string;
    tenant_id: string;
    external_user_id: string;
  };
};

function readSeed(): SeedData {
  const raw = process.env.E2E_SEED_JSON;
  if (!raw) {
    throw new Error(
      'E2E_SEED_JSON not set. Run `node src/seed-e2e.js` first and pass ' +
        'the JSON output via the E2E_SEED_JSON env var.'
    );
  }
  return JSON.parse(raw) as SeedData;
}

export const SEED: SeedData = readSeed();

export const ADMIN = SEED.users.admin;
export const MEMBER = SEED.users.member;
export const EMBED_USER = SEED.users.embed;

export const TENANT = SEED.tenant;
export const TENANT_KEY = SEED.tenantApiKey.plaintext;
export const EMBED_TOKEN = SEED.embedToken;
