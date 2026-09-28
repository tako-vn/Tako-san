import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWorker } from '../helpers/worker-fetch.mjs';
import { isRecipeCanaryTenant } from '../../packages/recipes/src/recipe-authority';
import {
  resetRecipeAuthorityCacheForTests,
  resetRecipeAuthorityCountersForTests,
} from '../../src/worker/services/recipe-authority';
import { resetRecipeCatalogShadowThrottle } from '../../src/worker/services/recipe-catalog-shadow';
import type { Env } from '../../src/worker/types';
import { SESSION_COOKIE, sha256Hex } from '../../src/worker/utils/session';
import { SqliteD1 } from '../helpers/sqlite-d1';

vi.mock('../../src/worker/services/email', () => ({ sendEmail: vi.fn(), buildOtpEmail: vi.fn() }));

/**
 * T19 hotfix — cooking must enforce the same canonical hard restrictions as the
 * planner and T20 Manual (T03 `evaluateHardRestrictions`, fail-closed).
 *
 * Regression: `POST /recipes/:id/cook/start` used to resolve the recipe and
 * return 200 without consulting household hard restrictions, so a recipe the
 * planner refuses (allergen / dietary / time / nutrition / forbidden / never
 * recommend) could still be cooked by calling the endpoint directly.
 * `POST /recipes/:id/cook/complete` had the same gap before its inventory
 * mutations.
 */
const ORIGIN = 'https://cook-restrictions.example.test';
// gl-03: static recipe, fully covered by STOCK below, prep_time_minutes IS NULL
// in D1 (so its total time is unknown, exactly like the planner sees it).
const RECIPE = 'gl-03';
// D1-only recipe relative to the 71 baseline, fully covered by STOCK.
const D1_ONLY = 'imp-26a36c69306143bc';
const CANDIDATES = Array.from({ length: 400 }, (_, index) => `t19hr-house-${index}`);
const INSIDE = CANDIDATES.find((id) => isRecipeCanaryTenant(id, 5))!;
const OUTSIDE = CANDIDATES.find((id) => !isRecipeCanaryTenant(id, 5))!;
const CASE_TIMEOUT_MS = 30_000;

type Mode = 'static' | 'shadow' | 'canary' | 'd1';
const MODE_ENV: Record<Mode, Partial<Env>> = {
  static: {},
  shadow: { RECIPE_CATALOG_MODE: 'shadow', RECIPE_CATALOG_SHADOW_INTERVAL_MS: '1000' },
  canary: {
    RECIPE_CATALOG_MODE: 'canary',
    RECIPE_CATALOG_CUTOVER_ENABLED: 'true',
    RECIPE_CATALOG_D1_CANARY_PERCENT: '5',
  },
  d1: { RECIPE_CATALOG_MODE: 'd1', RECIPE_CATALOG_CUTOVER_ENABLED: 'true' },
};

const STOCK = [
  ['CHICKEN_EGG', 'Trứng gà', 30, 'piece', 'egg'],
  ['TOMATO', 'Cà chua', 20, 'piece', 'vegetable'],
  ['SCALLION', 'Hành lá', 10, 'bunch', 'vegetable'],
  ['COOKING_OIL', 'Dầu ăn', 1000, 'ml', 'spice'],
  ['TOFU', 'Đậu phụ', 10, 'piece', 'vegetable'],
  ['SHRIMP', 'Tôm tươi', 1000, 'g', 'seafood'],
  ['BROCCOLI', 'Bông cải xanh', 5, 'piece', 'vegetable'],
  ['GARLIC', 'Tỏi', 20, 'piece', 'spice'],
  ['FISH_SAUCE', 'Nước mắm', 500, 'ml', 'spice'],
  ['RICE', 'Gạo', 5000, 'g', 'grain'],
  ['PORK_BELLY', 'Thịt ba chỉ', 2000, 'g', 'meat'],
] as const;

let db: SqliteD1;
let cookies: Record<string, string>;
let counter = 0;

async function seedHousehold(householdId: string) {
  counter += 1;
  const userId = `t19hr-user-${counter}`;
  db.seed(`INSERT INTO users (id, email, is_guest) VALUES ('${userId}', '${userId}@example.test', 0);
    INSERT INTO households (id, name, created_by) VALUES ('${householdId}', 'T19HR', '${userId}');
    INSERT INTO household_members (id, household_id, user_id, role) VALUES ('hm-${householdId}', '${householdId}', '${userId}', 'owner');
    INSERT INTO inventory_items (id, household_id, ingredient_id, name, quantity, unit, category, storage, freshness, data_source, version) VALUES
      ${STOCK.map(([id, name, qty, unit, category]) => `('t19hr-${id.toLowerCase()}-${householdId}', '${householdId}', '${id}', '${name}', ${qty}, '${unit}', '${category}', 'fridge', 'fresh', 'manual', 1)`).join(',\n')};`);
  const token = `t19hr-session-${householdId}-${counter}`;
  await db
    .prepare(
      `INSERT INTO sessions_v2 (id, user_id, household_id, token_hash, expires_at) VALUES (?, ?, ?, ?, '2099-01-01T00:00:00Z')`,
    )
    .bind(`sess-${householdId}`, userId, householdId, await sha256Hex(token))
    .run();
  cookies[householdId] = `${SESSION_COOKIE}=${token}`;
}

function setPreferences(householdId: string, values: Record<string, unknown>) {
  db.seed(`INSERT INTO household_ranking_preferences (household_id, values_json, updated_at)
    VALUES ('${householdId}', '${JSON.stringify({ version: 1, values })}', '2029-01-01T00:00:00.000Z')`);
}

function env(mode: Mode, extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    APP_URL: ORIGIN,
    ENVIRONMENT: 'development',
    MEAL_PLANNER_ENABLED: 'true',
    ...MODE_ENV[mode],
    ...extra,
  } as unknown as Env;
}

async function call(
  mode: Mode,
  householdId: string | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  resetRecipeAuthorityCacheForTests();
  const requestHeaders: Record<string, string> = {
    ...(householdId && cookies[householdId] ? { Cookie: cookies[householdId] } : {}),
    Origin: ORIGIN,
    Referer: ORIGIN,
    'Content-Type': 'application/json',
    ...headers,
  };
  const response = await fetchWorker(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env(mode),
  );
  const text = await response.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

function stockSnapshot(householdId: string) {
  return db.query('SELECT id, quantity FROM inventory_items WHERE household_id = ? ORDER BY id', householdId);
}

beforeEach(async () => {
  db = new SqliteD1();
  cookies = {};
  await seedHousehold(INSIDE);
  await seedHousehold(OUTSIDE);
  resetRecipeAuthorityCacheForTests();
  resetRecipeAuthorityCountersForTests();
  resetRecipeCatalogShadowThrottle();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  resetRecipeAuthorityCacheForTests();
});

describe('T19 cooking hard-restriction bypass — regression', () => {
  it.each([
    ['allergen requested (safety unknown, fail-closed)', { allergens: ['peanut'] }],
    ['dietary tag required (safety unknown, fail-closed)', { requiredDietaryTags: ['vegetarian'] }],
    ['hard max time with unknown total time (fail-closed)', { hardMaxTimeMinutes: 1 }],
    ['hard nutrition target without reviewed nutrition (fail-closed)', { mealNutritionTargets: [{ nutrient: 'proteinG', max: 80, hard: true }] }],
    ['never-recommend recipe', { neverRecommendRecipeIds: [RECIPE] }],
    ['forbidden ingredient in recipe', { forbiddenIngredientIds: ['CHICKEN_EGG'] }],
  ])('%s: cook/start is blocked with HARD_CONSTRAINT_CONFLICT', async (_label, values) => {
    setPreferences(INSIDE, values);
    const start = await call('d1', INSIDE, 'POST', `/recipes/${RECIPE}/cook/start`);
    expect(start.status, JSON.stringify(start.json)).toBe(422);
    expect(start.json.code).toBe('HARD_CONSTRAINT_CONFLICT');
  }, CASE_TIMEOUT_MS);

  it('allergen + dietary: cook/complete is blocked and writes nothing', async () => {
    for (const values of [{ allergens: ['peanut'] }, { requiredDietaryTags: ['vegetarian'] }]) {
      const householdId = `t19hr-blocked-${counter}`;
      await seedHousehold(householdId);
      setPreferences(householdId, values);
      const before = {
        cooked: (db.query('SELECT COUNT(*) AS n FROM cooked_meals') as any)[0].n,
        events: (db.query('SELECT COUNT(*) AS n FROM inventory_events') as any)[0].n,
        stock: JSON.stringify(stockSnapshot(householdId)),
      };
      const complete = await call('d1', householdId, 'POST', `/recipes/${RECIPE}/cook/complete`, {
        servings: 2,
        deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 2, unit: 'piece' }],
      }, { 'Idempotency-Key': `t19hr-blocked-${counter}` });
      expect(complete.status, JSON.stringify(complete.json)).toBe(422);
      expect(complete.json.code).toBe('HARD_CONSTRAINT_CONFLICT');
      expect((db.query('SELECT COUNT(*) AS n FROM cooked_meals') as any)[0].n).toBe(before.cooked);
      expect((db.query('SELECT COUNT(*) AS n FROM inventory_events') as any)[0].n).toBe(before.events);
      expect(JSON.stringify(stockSnapshot(householdId))).toBe(before.stock);
    }
  }, CASE_TIMEOUT_MS);

  it('allowed recipe: cook/start + cook/complete succeed and stay idempotent', async () => {
    const start = await call('d1', INSIDE, 'POST', `/recipes/${RECIPE}/cook/start`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    expect(start.json.recipeId).toBe(RECIPE);

    const key = `t19hr-happy-${counter}`;
    const body = {
      servings: 2,
      deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 2, unit: 'piece' }],
    };
    const first = await call('d1', INSIDE, 'POST', `/recipes/${RECIPE}/cook/complete`, body, { 'Idempotency-Key': key });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.success).toBe(true);
    const replay = await call('d1', INSIDE, 'POST', `/recipes/${RECIPE}/cook/complete`, body, { 'Idempotency-Key': key });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ success: true, idempotentReplay: true, cookId: first.json.cookId });
    expect((db.query('SELECT COUNT(*) AS n FROM cooked_meals WHERE household_id = ?', INSIDE) as any)[0].n).toBe(1);
  }, CASE_TIMEOUT_MS);

  it('cook/start requires authentication (tenancy guard)', async () => {
    const start = await call('d1', null, 'POST', `/recipes/${RECIPE}/cook/start`);
    expect(start.status).toBe(401);
  }, CASE_TIMEOUT_MS);

  it('D1-only recipe outside the cohort: cooking resolves 404, never a restriction bypass', async () => {
    for (const path of [`/recipes/${D1_ONLY}/cook/start`] as const) {
      const start = await call('canary', OUTSIDE, 'POST', path);
      expect(start.status, path).toBe(404);
    }
    const complete = await call('canary', OUTSIDE, 'POST', `/recipes/${D1_ONLY}/cook/complete`, {
      servings: 2,
      deductions: [{ ingredientId: 'SHRIMP', quantityDeducted: 100, unit: 'g' }],
    }, { 'Idempotency-Key': `t19hr-outside-${counter}` });
    expect(complete.status).toBe(404);
  }, CASE_TIMEOUT_MS);

  it('D1-only recipe inside the cohort: visible and still restriction-enforced', async () => {
    const start = await call('canary', INSIDE, 'POST', `/recipes/${D1_ONLY}/cook/start`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    expect(start.json.recipeId).toBe(D1_ONLY);

    setPreferences(INSIDE, { allergens: ['peanut'] });
    const blocked = await call('canary', INSIDE, 'POST', `/recipes/${D1_ONLY}/cook/start`);
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(422);
    expect(blocked.json.code).toBe('HARD_CONSTRAINT_CONFLICT');
  }, CASE_TIMEOUT_MS);

  it('authority matrix: the same restriction verdict under static, shadow, canary and d1', async () => {
    setPreferences(INSIDE, { allergens: ['peanut'] });
    const cases: Array<[Mode, string, number]> = [
      ['static', INSIDE, 422],
      ['shadow', INSIDE, 422],
      ['canary', INSIDE, 422],
      ['d1', INSIDE, 422],
    ];
    for (const [mode, householdId, expected] of cases) {
      const start = await call(mode, householdId, 'POST', `/recipes/${RECIPE}/cook/start`);
      expect(start.status, `${mode}: ${JSON.stringify(start.json)}`).toBe(expected);
      if (expected === 422) expect(start.json.code).toBe('HARD_CONSTRAINT_CONFLICT');
    }
    // Outside the canary cohort the static universe still enforces the same policy.
    const outside = await call('canary', OUTSIDE, 'POST', `/recipes/${RECIPE}/cook/start`);
    expect(outside.status).toBe(200); // no preferences set for OUTSIDE
  }, CASE_TIMEOUT_MS);

  it('blocked cook/complete retry stays blocked and writes nothing', async () => {
    const householdId = `t19hr-retry-${counter}`;
    await seedHousehold(householdId);
    setPreferences(householdId, { forbiddenIngredientIds: ['CHICKEN_EGG'] });
    const key = `t19hr-retry-${counter}`;
    const body = {
      servings: 2,
      deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 2, unit: 'piece' }],
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const complete = await call('d1', householdId, 'POST', `/recipes/${RECIPE}/cook/complete`, body, { 'Idempotency-Key': key });
      expect(complete.status, `attempt ${attempt}: ${JSON.stringify(complete.json)}`).toBe(422);
      expect(complete.json.code).toBe('HARD_CONSTRAINT_CONFLICT');
    }
    expect((db.query('SELECT COUNT(*) AS n FROM cooked_meals WHERE household_id = ?', householdId) as any)[0].n).toBe(0);
    expect((db.query('SELECT COUNT(*) AS n FROM inventory_events WHERE household_id = ?', householdId) as any)[0].n).toBe(0);
  }, CASE_TIMEOUT_MS);

  it('cook/complete is tenant-scoped: household B cannot touch household A data', async () => {
    // A cooks successfully; B (no prefs) cooks the same recipe. Each household
    // only ever sees its own cooked_meals rows and inventory.
    const body = {
      servings: 2,
      deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 2, unit: 'piece' }],
    };
    const aKey = `t19hr-tenancy-a-${counter}`;
    const aComplete = await call('d1', INSIDE, 'POST', `/recipes/${RECIPE}/cook/complete`, body, { 'Idempotency-Key': aKey });
    expect(aComplete.status, JSON.stringify(aComplete.json)).toBe(200);
    const bKey = `t19hr-tenancy-b-${counter}`;
    const bComplete = await call('d1', OUTSIDE, 'POST', `/recipes/${RECIPE}/cook/complete`, body, { 'Idempotency-Key': bKey });
    expect(bComplete.status, JSON.stringify(bComplete.json)).toBe(200);
    expect((db.query('SELECT COUNT(*) AS n FROM cooked_meals WHERE household_id = ?', INSIDE) as any)[0].n).toBe(1);
    expect((db.query('SELECT COUNT(*) AS n FROM cooked_meals WHERE household_id = ?', OUTSIDE) as any)[0].n).toBe(1);
    // B cannot replay A's idempotency key: the key is namespaced per household.
    const crossReplay = await call('d1', OUTSIDE, 'POST', `/recipes/${RECIPE}/cook/complete`, body, { 'Idempotency-Key': aKey });
    expect(crossReplay.status, JSON.stringify(crossReplay.json)).toBe(200);
    expect(crossReplay.json.idempotentReplay).not.toBe(true);
  }, CASE_TIMEOUT_MS);

  it('cook/complete restriction verdict is consistent across authority modes', async () => {
    setPreferences(INSIDE, { allergens: ['peanut'] });
    const body = {
      servings: 2,
      deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 2, unit: 'piece' }],
    };
    for (const mode of ['static', 'shadow', 'canary', 'd1'] as const) {
      const complete = await call(mode, INSIDE, 'POST', `/recipes/${RECIPE}/cook/complete`, body, { 'Idempotency-Key': `t19hr-matrix-${mode}-${counter}` });
      expect(complete.status, `${mode}: ${JSON.stringify(complete.json)}`).toBe(422);
      expect(complete.json.code).toBe('HARD_CONSTRAINT_CONFLICT');
    }
  }, CASE_TIMEOUT_MS);
});
