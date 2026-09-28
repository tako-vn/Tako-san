import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { recipeRoutes } from '../../src/worker/routes/recipes';
import { weekRoutes } from '../../src/worker/routes/week';
import { signJwt } from '../../src/worker/utils/jwt';
import type { AuthContext, Env } from '../../src/worker/types';

const integrationApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
integrationApp.use('*', authMiddleware);
integrationApp.route('/', recipeRoutes);
integrationApp.route('/', weekRoutes);

/** Minimal D1 adapter backed by Node's in-memory SQLite for HTTP integration tests. */
class SqliteD1 {
  private readonly sqlite = new DatabaseSync(':memory:');

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  prepare(sql: string) {
    const sqlite = this.sqlite;
    let values: any[] = [];
    return {
      sql,
      bind(...nextValues: any[]) {
        values = nextValues;
        return this;
      },
      async first<T = unknown>(): Promise<T | null> {
        return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
      },
      async all<T = unknown>() {
        return { results: sqlite.prepare(sql).all(...values) as T[], success: true, meta: {} };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }

  async batch(
    statements: Array<{
      run: () => Promise<{ success: boolean; meta: Record<string, unknown> }>;
      all: () => Promise<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }>;
    }>
  ) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) {
        // The T19 cooking hard-restriction check reads the ranking context via
        // db.batch(). Real D1 returns row results for SELECTs in a batch; this
        // adapter must do the same instead of dropping them via .run().
        const isSelect = /^\s*select/i.test((statement as any).sql ?? '');
        results.push(isSelect ? await statement.all() : await statement.run());
      }
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  seed(sql: string): void {
    this.sqlite.exec(sql);
  }

  query<T = Record<string, unknown>>(sql: string, ...values: any[]): T[] {
    return this.sqlite.prepare(sql).all(...values) as T[];
  }
}

const USER_ID = 'itest_user_week';
const HOUSEHOLD_ID = `hh_${USER_ID}`;
const JWT_SECRET = 'integration-test-secret-that-is-long-enough';

function applyMigrations(db: SqliteD1): void {
  const migrationDir = path.resolve(process.cwd(), 'migrations');
  for (const file of fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
    db.seed(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
  }
}

async function authHeader(): Promise<string> {
  const token = await signJwt(
    {
      sub: USER_ID,
      hid: HOUSEHOLD_ID,
      typ: 'access',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET
  );
  return `Bearer ${token}`;
}

async function request(
  db: SqliteD1,
  method: string,
  route: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { Authorization: await authHeader(), ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await integrationApp.fetch(
    new Request(`https://itest.local${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      DB: db as any,
      ENVIRONMENT: 'test',
      JWT_SECRET,
      WEEK_SCHEMA_MODE: 'legacy',
    } as any
  );
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function seedFixture(db: SqliteD1): void {
  applyMigrations(db);
  db.seed(`
    INSERT INTO users (id, email, is_guest) VALUES ('${USER_ID}', 'week-itest@frigo.local', 0);
    INSERT INTO households (id, name, created_by) VALUES ('${HOUSEHOLD_ID}', 'Week integration', '${USER_ID}');
    INSERT INTO household_members (id, household_id, user_id, role) VALUES ('hm_${USER_ID}', '${HOUSEHOLD_ID}', '${USER_ID}', 'owner');
    INSERT INTO inventory_items (id, household_id, ingredient_id, name, quantity, unit, category, storage, freshness, data_source)
      VALUES
      ('itest-eggs', '${HOUSEHOLD_ID}', 'CHICKEN_EGG', 'Trứng gà', 12, 'piece', 'egg', 'fridge', 'fresh', 'manual'),
      ('itest-tomato', '${HOUSEHOLD_ID}', 'TOMATO', 'Cà chua', 10, 'piece', 'vegetable', 'fridge', 'fresh', 'manual'),
      ('itest-scallion', '${HOUSEHOLD_ID}', 'SCALLION', 'Hành lá', 5, 'bunch', 'vegetable', 'fridge', 'fresh', 'manual'),
      ('itest-oil', '${HOUSEHOLD_ID}', 'COOKING_OIL', 'Dầu ăn', 300, 'ml', 'spice', 'pantry', 'fresh', 'manual'),
      ('itest-tofu', '${HOUSEHOLD_ID}', 'TOFU', 'Đậu phụ', 4, 'piece', 'vegetable', 'fridge', 'fresh', 'manual');
  `);
}

describe('Week core HTTP flow (in-memory D1)', () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = new SqliteD1();
    seedFixture(db);
  });

  it('creates, reads, regenerates, and swaps a plan while preserving relational state', async () => {
    const create = await request(db, 'POST', '/week/plans', {
      planId: 'plan_itest_week_001',
      startDate: '2026-09-07',
      householdSize: 2,
      mealSlotsPreset: 'dinner_only',
      priorities: ['use_fridge'],
      shoppingFrequency: 'once',
    });
    expect(create.status).toBe(201);
    expect(create.json.plan.id).toBe('plan_itest_week_001');
    expect(create.json.plan.days).toHaveLength(7);
    expect(db.query('SELECT COUNT(*) AS count FROM meal_plan_days WHERE plan_id = ?', 'plan_itest_week_001')[0].count).toBe(7);

    const current = await request(db, 'GET', '/week/current');
    expect(current.status).toBe(200);
    expect(current.json.plan.id).toBe('plan_itest_week_001');

    const regenerate = await request(db, 'POST', '/week/plans/plan_itest_week_001/generate');
    expect(regenerate.status).toBe(200);
    expect(regenerate.json.plan.id).not.toBe('plan_itest_week_001');
    expect(db.query("SELECT status FROM meal_plans WHERE id = 'plan_itest_week_001'")[0].status).toBe('ARCHIVED');
    expect(db.query("SELECT COUNT(*) AS count FROM meal_plan_slots WHERE plan_id = 'plan_itest_week_001'")[0].count).toBe(0);
    expect(db.query('SELECT COUNT(*) AS count FROM meal_plan_slots WHERE plan_id = ?', regenerate.json.plan.id)[0].count).toBeGreaterThan(0);

    // Swap is exercised on the newly active regenerated plan.
    const regenerated = regenerate.json.plan;
    const slot = regenerated.days.flatMap((day: any) => day.slots).find((candidate: any) => candidate.recipe);
    expect(slot).toBeTruthy();
    const swap = await request(db, 'POST', `/week/plans/${regenerated.id}/meals/${slot.id}/swap`, { recipeId: 'tomato-egg-stir-fry' });
    expect(swap.status).toBe(200);
    expect(swap.json.plan.days.flatMap((day: any) => day.slots).find((candidate: any) => candidate.id === slot.id).recipe.slug).toBe('tomato-egg-stir-fry');
  });

  it('toggles shopping, imports idempotently, and records inventory ledger rows', async () => {
    const create = await request(db, 'POST', '/week/plans', {
      planId: 'plan_itest_shop_001',
      startDate: '2026-09-07',
      householdSize: 2,
      mealSlotsPreset: 'dinner_only',
      priorities: ['budget'],
      shoppingFrequency: 'once',
    });
    expect(create.status).toBe(201);
    const plan = create.json.plan;
    const shopping = await request(db, 'GET', `/week/plans/${plan.id}/shopping`);
    expect(shopping.status).toBe(200);
    expect(shopping.json.totalCount).toBeGreaterThan(0);
    const item = shopping.json.items[0];

    const toggle = await request(db, 'PATCH', `/week/plans/${plan.id}/shopping/items/${item.ingredientId}`, { checked: true });
    expect(toggle.status).toBe(200);
    expect(toggle.json.item.checked).toBe(true);

    const key = 'shop-itest-001';
    const complete = await request(
      db,
      'POST',
      `/week/plans/${plan.id}/shopping/complete`,
      { items: [{ ingredientId: item.ingredientId }] },
      { 'Idempotency-Key': key }
    );
    expect(complete.status).toBe(200);
    expect(complete.json.importedItemsCount).toBe(1);
    expect(db.query('SELECT status FROM shopping_runs WHERE plan_id = ?', plan.id)[0].status).toBe('completed');
    expect(db.query('SELECT COUNT(*) AS count FROM shopping_run_items')[0].count).toBe(1);

    const replay = await request(
      db,
      'POST',
      `/week/plans/${plan.id}/shopping/complete`,
      { items: [{ ingredientId: item.ingredientId }] },
      { 'Idempotency-Key': key }
    );
    expect(replay.status).toBe(200);
    expect(replay.json.idempotentReplay).toBe(true);
    expect(db.query("SELECT COUNT(*) AS count FROM inventory_events WHERE event_type = 'SHOPPING_IMPORT' AND household_id = ?", HOUSEHOLD_ID)[0].count).toBe(1);
  });

  it('completes cooking with FIFO deductions and protects replay from double-debit', async () => {
    const first = await request(db, 'POST', '/recipes/tomato-egg-stir-fry/cook/start');
    expect(first.status).toBe(200);
    expect(first.json.recipeId).toBe('gl-03');

    const key = 'cook-itest-001';
    const deductions = [
      { ingredientId: 'CHICKEN_EGG', quantityDeducted: 3, unit: 'piece' },
      { ingredientId: 'TOMATO', quantityDeducted: 2, unit: 'piece' },
      { ingredientId: 'SCALLION', quantityDeducted: 1, unit: 'bunch' },
      { ingredientId: 'COOKING_OIL', quantityDeducted: 15, unit: 'ml' },
    ];
    const complete = await request(db, 'POST', '/recipes/gl-03/cook/complete', { servings: 2, deductions }, { 'Idempotency-Key': key });
    expect(complete.status).toBe(200);
    expect(complete.json.success).toBe(true);
    expect(db.query('SELECT quantity FROM inventory_items WHERE id = ?', 'itest-eggs')[0].quantity).toBe(9);
    expect(db.query("SELECT COUNT(*) AS count FROM inventory_events WHERE event_type = 'COOK' AND household_id = ?", HOUSEHOLD_ID)[0].count).toBe(4);

    const replay = await request(db, 'POST', '/recipes/gl-03/cook/complete', { servings: 2, deductions }, { 'Idempotency-Key': key });
    expect(replay.status).toBe(200);
    expect(replay.json.idempotentReplay).toBe(true);
    expect(db.query('SELECT quantity FROM inventory_items WHERE id = ?', 'itest-eggs')[0].quantity).toBe(9);
  });
});
