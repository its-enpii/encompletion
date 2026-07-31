/**
 * Auth fixture for the e2e suite. Reads the seeder output via env.
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
  };
  models: {
    workspace: number;
    sonnet: number;
    haiku: number;
  };
  project: { id: number; name: string };
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
