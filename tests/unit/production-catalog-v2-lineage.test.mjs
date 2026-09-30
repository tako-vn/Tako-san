import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadCanonicalV2Source,
  missingCanonicalReason,
  summarizeV2CatalogLineage,
} from "../../scripts/production-catalog-v2-lineage.mjs";

const names = readdirSync("migrations").filter((name) => /^\d+.*\.sql$/.test(name)).sort();
const sha = "a".repeat(40);
const artifactSha256 = "b".repeat(64);
const manifest = {
  sha, mainSha: sha, environment: "production",
  cloudflare: { databaseName: "frigo-db", databaseId: "f975ec39-b2c8-4a2a-80e1-0366054599d3" },
  schema: { migrations: names.map((name) => ({ name, sha256: "c".repeat(64) })) },
};
const ledger = [{ success: true, results: names.slice(0, 38).map((name) => ({ name })) }];
const result = (results) => ({ success: true, results });
const coverage = (ingredientRows) => [result([{
  ingredient_rows: ingredientRows, order_rows: 0, ingredients_without_matching_order: ingredientRows,
  recipes_with_missing_order: ingredientRows ? 1 : 0, orders_without_matching_ingredient: 0,
}])];

function v2Line(overrides = {}) {
  return {
    recipeId: "r1", position: 0, ingredientId: "SALT", name: "Muoi",
    quantity: 5, unit: "g", optional: 0, runtimeQuantity: 5, runtimeUnit: "g",
    usageRole: "consumed", includeInShopping: true, quantityKind: "measured", evidence: "source_explicit",
    ...overrides,
  };
}

function canonicalOf(lines, recipeIds = [...new Set(lines.map((line) => line.recipeId))]) {
  return {
    lines, recipeIds, recipeCount: recipeIds.length, lineCount: lines.length,
    artifactSha256, productionReleaseReady: false, runtimeProjectionReady: false, blockers: ["RUNTIME_PROJECTION_LOSS"],
  };
}

function prod(overrides = {}) {
  return {
    id: overrides.id ?? "line-1", recipe_id: "r1", ingredient_id: "SALT", name: "Muoi",
    required_quantity: 5, unit: "g", is_optional: 0, ...overrides,
  };
}

function summarize(productionRows, canonical, recipes = [{ id: "r1", version: 2 }], extra = {}) {
  return summarizeV2CatalogLineage({
    manifest, before: ledger, after: ledger,
    runtime: [result(recipes), result(productionRows), result([]), result([]), result([])],
    orderCoverage: coverage(productionRows.length),
    canonical,
    checkedAt: "2026-09-30T00:00:00.000Z",
    ...extra,
  });
}

describe("production catalog V2 semantic lineage", () => {
  it("loads and fingerprints the reviewed canonical V2 package", () => {
    const canonical = loadCanonicalV2Source();
    expect(canonical.recipeCount).toBe(500);
    expect(canonical.lineCount).toBe(6766);
    expect(canonical.artifactSha256).toBe("da87da20475fa8d7ec92c716e899ee572339573258ae6d9cc7f3f8f554f2d695");
    expect(canonical.productionReleaseReady).toBe(false);
    expect(canonical.runtimeProjectionReady).toBe(false);
  });

  it("matches an exact full V2 recipe and grants only a position candidate", () => {
    const lines = [
      v2Line(),
      v2Line({ position: 1, ingredientId: "SUGAR", name: "Duong", quantity: 10, runtimeQuantity: 10 }),
    ];
    const receipt = summarize([
      prod(),
      prod({ id: "line-2", ingredient_id: "SUGAR", name: "Duong", required_quantity: 10 }),
    ], canonicalOf(lines));
    expect(receipt.status).toBe("V2_SEMANTIC_LINEAGE_PROVEN");
    expect(receipt.certification).toBe("NOT_A_RELEASE_CERTIFICATION");
    expect(receipt.semanticComparison).toMatchObject({ exactMatches: 2, normalizedMatches: 0, productionOnly: 0, ambiguousMatches: 0, malformed: 0 });
    expect(receipt.proof).toMatchObject({
      productionIsExactCanonicalV2: true,
      productionIsSemanticSubsetOfCanonicalV2: true,
      uniquePositionAuthorityAvailable: true,
      semanticV2LineageProven: true,
      ingestionPipelineProven: false,
    });
    expect(receipt.researchV2LineageProven).toBe(false);
    expect(receipt.positionAuthority).toBe("CANONICAL_V2_ORDER_CANDIDATE");
    expect(receipt.recipes.exactV2Recipes).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain("Muoi");
    expect(JSON.stringify(receipt)).not.toContain("line-1");
  });

  it("treats a 6720-style subset with proven missing lines as V2 subset without position invention", () => {
    const lines = [
      v2Line(),
      v2Line({ position: 1, ingredientId: "SUGAR", name: "Duong", quantity: 10, runtimeQuantity: 10 }),
      v2Line({
        position: 2, ingredientId: "WATER", name: "Nuoc", quantity: null, unit: "", optional: 0,
        runtimeQuantity: null, runtimeUnit: "", usageRole: "qualitative", includeInShopping: false,
        quantityKind: "qualitative", evidence: "missing",
      }),
    ];
    const receipt = summarize([
      prod(),
      prod({ id: "line-2", ingredient_id: "SUGAR", name: "Duong", required_quantity: 10 }),
    ], canonicalOf(lines));
    expect(receipt.status).toBe("V2_SEMANTIC_LINEAGE_PROVEN");
    expect(receipt.semanticComparison.exactMatches).toBe(2);
    expect(receipt.canonicalCoverage.missing).toBe(1);
    expect(receipt.missingCanonicalLines.reasonCounts.qualitative_quantity).toBe(1);
    expect(receipt.proof.productionIsExactCanonicalV2).toBe(false);
    expect(receipt.proof.productionIsSemanticSubsetOfCanonicalV2).toBe(true);
    expect(receipt.proof.missingLinesFullyExplained).toBe(true);
    expect(receipt.recipes.subsetRecipes).toBe(1);
    expect(receipt.positionAuthority).toBe("CANONICAL_V2_ORDER_CANDIDATE");
  });

  it("stops as live-source unresolved when production has a row absent from V2", () => {
    const receipt = summarize([
      prod(),
      prod({ id: "line-x", ingredient_id: "UNKNOWN", name: "SecretFishSauce", required_quantity: 1, unit: "ml" }),
    ], canonicalOf([v2Line()]));
    expect(receipt.status).toBe("PRODUCTION_LIVE_SOURCE_UNRESOLVED");
    expect(receipt.semanticComparison.productionOnly).toBe(1);
    expect(receipt.proof.productionIsSemanticSubsetOfCanonicalV2).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("SecretFishSauce");
  });

  it("counts quantity mismatch as semantic drift, not a match", () => {
    const receipt = summarize([prod({ required_quantity: 9 })], canonicalOf([v2Line()]));
    expect(receipt.status).toBe("PRODUCTION_LIVE_SOURCE_UNRESOLVED");
    expect(receipt.semanticComparison.exactMatches).toBe(0);
    expect(receipt.semanticComparison.productionOnly).toBe(1);
    expect(receipt.canonicalCoverage.missing).toBe(1);
  });

  it("counts unit mismatch as unmatched", () => {
    const receipt = summarize([prod({ unit: "ml" })], canonicalOf([v2Line()]));
    expect(receipt.semanticComparison.exactMatches).toBe(0);
    expect(receipt.semanticComparison.productionOnly).toBe(1);
  });

  it("keeps duplicate same-name different-quantity lines unique", () => {
    const lines = [
      v2Line({ name: "Dau", ingredientId: "OIL", quantity: 1, unit: "tbsp", runtimeQuantity: 1, runtimeUnit: "tbsp" }),
      v2Line({ position: 1, name: "Dau", ingredientId: "OIL", quantity: 1, unit: "tsp", runtimeQuantity: 1, runtimeUnit: "tsp" }),
    ];
    const receipt = summarize([
      prod({ name: "Dau", ingredient_id: "OIL", required_quantity: 1, unit: "tbsp" }),
      prod({ id: "line-2", name: "Dau", ingredient_id: "OIL", required_quantity: 1, unit: "tsp" }),
    ], canonicalOf(lines));
    expect(receipt.semanticComparison.exactMatches).toBe(2);
    expect(receipt.ordering.uniquelyMappedLines).toBe(2);
    expect(receipt.positionAuthority).toBe("CANONICAL_V2_ORDER_CANDIDATE");
  });

  it("marks duplicate same-name+quantity occurrences position-ambiguous", () => {
    const lines = [
      v2Line({ name: "Dau", ingredientId: "OIL", quantity: 1, unit: "tbsp", runtimeQuantity: 1, runtimeUnit: "tbsp" }),
      v2Line({ position: 1, name: "Dau", ingredientId: "OIL", quantity: 1, unit: "tbsp", runtimeQuantity: 1, runtimeUnit: "tbsp" }),
    ];
    const receipt = summarize([
      prod({ name: "Dau", ingredient_id: "OIL", required_quantity: 1, unit: "tbsp" }),
      prod({ id: "line-2", name: "Dau", ingredient_id: "OIL", required_quantity: 1, unit: "tbsp" }),
    ], canonicalOf(lines));
    expect(receipt.status).toBe("V2_SEMANTIC_LINEAGE_PROVEN");
    expect(receipt.semanticComparison.exactMatches).toBe(2);
    expect(receipt.ordering.uniquelyMappedLines).toBe(0);
    expect(receipt.ordering.ambiguousPositionLines).toBe(2);
    expect(receipt.proof.uniquePositionAuthorityAvailable).toBe(false);
    expect(receipt.positionAuthority).toBe("PARTIAL");
  });

  it("classifies mixed exact keys that share a normalized name as ambiguous", () => {
    const lines = [
      v2Line({ name: "Hanh la", ingredientId: "SCALLION", quantity: 1, unit: "g" }),
      v2Line({ position: 1, name: "Hanh  la", ingredientId: "ONION", quantity: 1, unit: "g" }),
    ];
    const receipt = summarize([
      prod({ name: "hanh la", ingredient_id: "OTHER", required_quantity: 1, unit: "g" }),
    ], canonicalOf(lines));
    expect(receipt.status).toBe("V2_LINEAGE_PARTIAL");
    expect(receipt.semanticComparison.ambiguousMatches).toBe(1);
    expect(receipt.proof.productionIsSemanticSubsetOfCanonicalV2).toBe(false);
    expect(receipt.positionAuthority).toBe("NONE");
  });

  it("matches NFKC/trim/case-normalized names without dropping quantity", () => {
    const receipt = summarize(
      [prod({ name: "  MUOI  " })],
      canonicalOf([v2Line({ name: "Muoi" })]),
    );
    expect(receipt.semanticComparison.exactMatches).toBe(0);
    expect(receipt.semanticComparison.normalizedMatches).toBe(1);
    expect(receipt.status).toBe("V2_SEMANTIC_LINEAGE_PROVEN");
  });

  it("matches production rows onto V2 runtime quantity when source units differ", () => {
    const receipt = summarize(
      [prod({ required_quantity: 15, unit: "g" })],
      canonicalOf([v2Line({ quantity: 1, unit: "tbsp", runtimeQuantity: 15, runtimeUnit: "g" })]),
    );
    expect(receipt.semanticComparison.exactRuntimeMatches).toBe(1);
    expect(receipt.semanticComparison.exactMatches).toBe(1);
    expect(receipt.status).toBe("V2_SEMANTIC_LINEAGE_PROVEN");
  });

  it("reports recipe ID drift without matching across recipes", () => {
    const receipt = summarize(
      [prod({ recipe_id: "r2" })],
      canonicalOf([v2Line()], ["r1"]),
      [{ id: "r2", version: 2 }],
    );
    expect(receipt.recipes.liveRecipeIdsNotInCanonical).toBe(1);
    expect(receipt.recipes.canonicalRecipeIdsAbsentFromLive).toBe(1);
    expect(receipt.semanticComparison.productionOnly).toBe(1);
    expect(receipt.proof.recipeIdSetMatches).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("r2");
  });

  it("counts malformed production rows separately", () => {
    const receipt = summarize(
      [{ id: "bad", recipe_id: "r1", ingredient_id: "SALT", name: "Muoi", required_quantity: -1, unit: "g", is_optional: 0 }],
      canonicalOf([v2Line()]),
    );
    expect(receipt.semanticComparison.malformed).toBe(1);
    expect(receipt.semanticComparison.exactMatches).toBe(0);
    expect(receipt.status).toBe("V2_LINEAGE_UNRESOLVED");
  });

  it("classifies qualitative missing reasons without treating them as matches", () => {
    expect(missingCanonicalReason(v2Line({
      quantity: null, unit: "", runtimeQuantity: null, runtimeUnit: "",
      quantityKind: "qualitative", usageRole: "qualitative", includeInShopping: false,
    }))).toBe("qualitative_quantity");
    expect(missingCanonicalReason(v2Line({
      usageRole: "process_only", includeInShopping: true, runtimeQuantity: null,
    }))).toBe("process_only");
  });

  it("runs the CLI against the real V2 package and writes only sanitized aggregates", () => {
    const canonical = loadCanonicalV2Source();
    const directory = mkdtempSync(path.join(tmpdir(), "production-v2-lineage-cli-"));
    try {
      const recipes = canonical.recipeIds.map((id) => ({ id, version: 2 }));
      const productionRows = [{
        id: "private-line-id", recipe_id: canonical.recipeIds[0], ingredient_id: "PRIVATE_ING",
        name: "SecretPrivateIngredientName", required_quantity: 99, unit: "g", is_optional: 0,
      }];
      const inputs = [
        manifest, ledger,
        [result(recipes), result(productionRows), result([]), result([]), result([])],
        coverage(1), ledger,
      ];
      const inputPaths = inputs.map((input, index) => {
        const file = path.join(directory, "input-" + index + ".json");
        writeFileSync(file, JSON.stringify(input));
        return file;
      });
      const receiptPath = path.join(directory, "receipt.json");
      execFileSync(process.execPath, [
        path.resolve("scripts/production-catalog-v2-lineage.mjs"), ...inputPaths, receiptPath,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const serialized = readFileSync(receiptPath, "utf8");
      const receipt = JSON.parse(serialized);
      expect(receipt.certification).toBe("NOT_A_RELEASE_CERTIFICATION");
      expect(receipt.canonicalV2.lineCount).toBe(6766);
      expect(receipt.productionMutations).toEqual([]);
      expect(receipt.researchV2LineageProven).toBe(false);
      expect(serialized).not.toContain("SecretPrivateIngredientName");
      expect(serialized).not.toContain("private-line-id");
      expect(serialized).not.toContain("PRIVATE_ING");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
