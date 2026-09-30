import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isExistingCanonicalAuthority,
  loadCanonicalV2Source,
  loadReconciliationAuthority,
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

function assertCountInvariant(receipt, productionCount) {
  const cmp = receipt.semanticComparison;
  expect(cmp.authoritativeMatches + cmp.informationalOnlyMatches + cmp.productionOnly + cmp.ambiguousMatches + cmp.malformed)
    .toBe(productionCount);
}

describe("production catalog V2 semantic lineage", () => {
  it("loads and fingerprints the reviewed canonical V2 package", () => {
    const canonical = loadCanonicalV2Source();
    expect(canonical.recipeCount).toBe(500);
    expect(canonical.lineCount).toBe(6766);
    expect(canonical.artifactSha256).toBe("da87da20475fa8d7ec92c716e899ee572339573258ae6d9cc7f3f8f554f2d695");
    expect(canonical.productionReleaseReady).toBe(false);
  });

  it("matches exact ID-consistent lines as authoritative relative-order evidence only", () => {
    const lines = [
      v2Line(),
      v2Line({ position: 1, ingredientId: "SUGAR", name: "Duong", quantity: 10, runtimeQuantity: 10 }),
    ];
    const receipt = summarize([
      prod(),
      prod({ id: "line-2", ingredient_id: "SUGAR", name: "Duong", required_quantity: 10 }),
    ], canonicalOf(lines));
    expect(receipt.status).toBe("V2_AUTHORITATIVE_SEMANTIC_LINEAGE_PROVEN");
    expect(receipt.certification).toBe("NOT_A_RELEASE_CERTIFICATION");
    expect(receipt.semanticComparison.authoritativeMatches).toBe(2);
    expect(receipt.proof).toMatchObject({
      productionIsAuthoritativeV2Subset: true,
      semanticV2LineageProven: true,
      ingestionPipelineProven: false,
      runtimePositionAuthority: false,
      missingLinesCausallyExplained: false,
    });
    expect(receipt.researchV2LineageProven).toBe(false);
    expect(receipt.positionAuthority).toBe("CANONICAL_V2_RELATIVE_ORDER_CANDIDATE");
    expect(receipt.runtimePositionAuthority).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("Muoi");
    expect(JSON.stringify(receipt)).not.toContain("line-1");
    assertCountInvariant(receipt, 2);
  });

  it("classifies missing canonical metadata without claiming causal proof", () => {
    const lines = [
      v2Line(),
      v2Line({
        position: 1, ingredientId: "WATER", name: "Nuoc", quantity: 100, unit: "ml",
        runtimeQuantity: 100, runtimeUnit: "ml", includeInShopping: false, usageRole: "consumed",
      }),
    ];
    const receipt = summarize([prod()], canonicalOf(lines));
    expect(receipt.missingCanonicalLines.candidateReasonCounts.non_shopping).toBe(1);
    expect(receipt.missingCanonicalLines.classified).toBe(1);
    expect(receipt.proof.missingLinesMetadataClassified).toBe(true);
    expect(receipt.proof.missingLinesCausallyExplained).toBe(false);
    expect(receipt.recipes.subsetRecipes).toBe(1);
    expect(JSON.stringify(receipt)).not.toMatch(/PROVEN_MISSING|fully explained/i);
    expect(receipt.runtimePositionAuthority).toBe(false);
    assertCountInvariant(receipt, 1);
  });

  it("does not treat ID-conflict content matches as authoritative lineage", () => {
    const receipt = summarize(
      [prod({ ingredient_id: "ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "SCALLION", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
    );
    expect(receipt.semanticComparison.authoritativeMatches).toBe(0);
    expect(receipt.semanticComparison.idConflictContentMatches).toBe(1);
    expect(receipt.proof.semanticV2LineageProven).toBe(false);
    expect(receipt.proof.productionIsAuthoritativeV2Subset).toBe(false);
    expect(receipt.proof.unresolvedIngredientIdentityConflicts).toBe(true);
    expect(receipt.status).toBe("V2_CONTENT_LINEAGE_SUGGESTED_IDENTITY_UNRESOLVED");
    expect(receipt.positionAuthority).toBe("NONE");
    assertCountInvariant(receipt, 1);
  });

  it("does not grant cross-ID authority from provisional reconciliation", () => {
    const receipt = summarize(
      [prod({ ingredient_id: "ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "ING_ENR_PROVISIONAL", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      {
        reconciliation: [{
          sourceName: "Hanh la", sourceId: "ONION", canonicalId: "ING_ENR_PROVISIONAL",
          resolution: "provisional_new_canonical_id", review: null,
        }],
      },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(0);
    expect(receipt.semanticComparison.authoritativeMatches).toBe(0);
    expect(receipt.proof.semanticV2LineageProven).toBe(false);
  });

  it("does not grant reviewed authority from wrong review fields", () => {
    const row = {
      sourceId: "SPRING_ONION", canonicalId: "ING_ENR_REVIEWED1",
      resolution: "reviewed_new_canonical_id", review: { reviewer: "fixture", evidence: "synthetic" },
    };
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "ING_ENR_REVIEWED1")).toBe(false);
    const receipt = summarize(
      [prod({ ingredient_id: "SPRING_ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "ING_ENR_REVIEWED1", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      { reconciliation: [row] },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(0);
    expect(receipt.proof.semanticV2LineageProven).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("fixture");
  });

  it("detects relative-order holes without granting runtime positions", () => {
    const lines = [
      v2Line({ ingredientId: "A", name: "A", quantity: 1, runtimeQuantity: 1 }),
      v2Line({ position: 1, ingredientId: "B", name: "B", quantity: 1, runtimeQuantity: 1 }),
      v2Line({ position: 2, ingredientId: "C", name: "C", quantity: 1, runtimeQuantity: 1 }),
      v2Line({ position: 3, ingredientId: "D", name: "D", quantity: 1, runtimeQuantity: 1 }),
    ];
    const receipt = summarize([
      prod({ ingredient_id: "A", name: "A", required_quantity: 1 }),
      prod({ id: "line-c", ingredient_id: "C", name: "C", required_quantity: 1 }),
      prod({ id: "line-d", ingredient_id: "D", name: "D", required_quantity: 1 }),
    ], canonicalOf(lines));
    expect(receipt.ordering.uniquelyMappedSourceLines).toBe(3);
    expect(receipt.ordering.recipesWithPositionHoles).toBe(1);
    expect(receipt.ordering.requiresContiguousReindex).toBe(true);
    expect(receipt.runtimePositionAuthority).toBe(false);
    expect(receipt.proof.runtimePositionAuthority).toBe(false);
    expect(receipt.positionAuthority).toBe("CANONICAL_V2_RELATIVE_ORDER_CANDIDATE");
    expect(JSON.stringify(receipt)).not.toContain("line-c");
    assertCountInvariant(receipt, 3);
  });

  it("keeps contiguous subsets from authorizing runtime insertion", () => {
    const lines = [
      v2Line({ ingredientId: "A", name: "A", quantity: 1, runtimeQuantity: 1 }),
      v2Line({ position: 1, ingredientId: "B", name: "B", quantity: 1, runtimeQuantity: 1 }),
      v2Line({ position: 2, ingredientId: "C", name: "C", quantity: 1, runtimeQuantity: 1 }),
    ];
    const receipt = summarize([
      prod({ ingredient_id: "A", name: "A", required_quantity: 1 }),
      prod({ id: "line-b", ingredient_id: "B", name: "B", required_quantity: 1 }),
    ], canonicalOf(lines));
    expect(receipt.ordering.recipesWithPositionHoles).toBe(0);
    expect(receipt.runtimePositionAuthority).toBe(false);
    expect(receipt.proof.runtimePositionAuthority).toBe(false);
    expect(receipt.positionAuthority).toBe("CANONICAL_V2_RELATIVE_ORDER_CANDIDATE");
  });

  it("keeps duplicate same-name+quantity occurrences source-order ambiguous", () => {
    const lines = [
      v2Line({ name: "Dau", ingredientId: "OIL", quantity: 1, unit: "tbsp", runtimeQuantity: 1, runtimeUnit: "tbsp" }),
      v2Line({ position: 1, name: "Dau", ingredientId: "OIL", quantity: 1, unit: "tbsp", runtimeQuantity: 1, runtimeUnit: "tbsp" }),
    ];
    const receipt = summarize([
      prod({ name: "Dau", ingredient_id: "OIL", required_quantity: 1, unit: "tbsp" }),
      prod({ id: "line-2", name: "Dau", ingredient_id: "OIL", required_quantity: 1, unit: "tbsp" }),
    ], canonicalOf(lines));
    expect(receipt.semanticComparison.authoritativeMatches).toBe(2);
    expect(receipt.ordering.uniquelyMappedSourceLines).toBe(0);
    expect(receipt.ordering.sourceOrderAmbiguousLines).toBe(2);
    expect(receipt.proof.relativeOrderUnique).toBe(false);
    expect(receipt.positionAuthority).toBe("PARTIAL");
    expect(receipt.runtimePositionAuthority).toBe(false);
  });

  it("matches NFKC/trim/case-normalized names only when ingredient IDs agree", () => {
    const receipt = summarize(
      [prod({ name: "  MUOI  " })],
      canonicalOf([v2Line({ name: "Muoi" })]),
    );
    expect(receipt.semanticComparison.normalizedIdMatches).toBe(1);
    expect(receipt.semanticComparison.authoritativeMatches).toBe(1);
    expect(receipt.status).toBe("V2_AUTHORITATIVE_SEMANTIC_LINEAGE_PROVEN");
  });

  it("matches production rows onto V2 runtime quantity when IDs agree", () => {
    const receipt = summarize(
      [prod({ required_quantity: 15, unit: "g" })],
      canonicalOf([v2Line({ quantity: 1, unit: "tbsp", runtimeQuantity: 15, runtimeUnit: "g" })]),
    );
    expect(receipt.semanticComparison.exactIdMatches).toBe(1);
    expect(receipt.status).toBe("V2_AUTHORITATIVE_SEMANTIC_LINEAGE_PROVEN");
  });

  it("stops as live-source unresolved when production has a row absent from V2", () => {
    const receipt = summarize([
      prod(),
      prod({ id: "line-x", ingredient_id: "UNKNOWN", name: "SecretFishSauce", required_quantity: 1, unit: "ml" }),
    ], canonicalOf([v2Line()]));
    expect(receipt.status).toBe("PRODUCTION_LIVE_SOURCE_UNRESOLVED");
    expect(receipt.semanticComparison.productionOnly).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain("SecretFishSauce");
    assertCountInvariant(receipt, 2);
  });

  it("counts quantity and unit mismatch as unmatched", () => {
    expect(summarize([prod({ required_quantity: 9 })], canonicalOf([v2Line()])).semanticComparison.productionOnly).toBe(1);
    expect(summarize([prod({ unit: "ml" })], canonicalOf([v2Line()])).semanticComparison.productionOnly).toBe(1);
  });

  it("reports recipe ID drift without matching across recipes", () => {
    const receipt = summarize(
      [prod({ recipe_id: "r2" })],
      canonicalOf([v2Line()], ["r1"]),
      [{ id: "r2", version: 2 }],
    );
    expect(receipt.recipes.liveRecipeIdsNotInCanonical).toBe(1);
    expect(receipt.proof.recipeIdSetMatches).toBe(false);
    expect(receipt.proof.productionIsAuthoritativeV2Subset).toBe(false);
    expect(receipt.proof.semanticV2LineageProven).toBe(false);
    expect(receipt.status).not.toBe("V2_AUTHORITATIVE_SEMANTIC_LINEAGE_PROVEN");
    expect(JSON.stringify(receipt)).not.toContain("r2");
  });

  it("counts malformed production rows separately and keeps the invariant", () => {
    const receipt = summarize(
      [{ id: "bad", recipe_id: "r1", ingredient_id: "SALT", name: "Muoi", required_quantity: -1, unit: "g", is_optional: 0 }],
      canonicalOf([v2Line()]),
    );
    expect(receipt.semanticComparison.malformed).toBe(1);
    expect(receipt.status).toBe("V2_LINEAGE_UNRESOLVED");
    assertCountInvariant(receipt, 1);
  });

  it("classifies qualitative missing reasons without treating them as matches", () => {
    expect(missingCanonicalReason(v2Line({
      quantity: null, unit: "", runtimeQuantity: null, runtimeUnit: "",
      quantityKind: "qualitative", usageRole: "qualitative", includeInShopping: false,
    }))).toBe("qualitative_quantity");
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
      expect(receipt.proof.missingLinesCausallyExplained).toBe(false);
      expect(receipt.runtimePositionAuthority).toBe(false);
      expect(serialized).not.toContain("SecretPrivateIngredientName");
      expect(serialized).not.toContain("private-line-id");
      expect(serialized).not.toContain("PRIVATE_ING");
      expect(serialized).not.toMatch(/PROVEN_MISSING|fully explained/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("does not grant reviewed authority from an empty review object", () => {
    const row = {
      sourceId: "SPRING_ONION", canonicalId: "ING_ENR_REVIEWED1",
      resolution: "reviewed_new_canonical_id", review: {},
    };
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "ING_ENR_REVIEWED1")).toBe(false);
    const receipt = summarize(
      [prod({ ingredient_id: "SPRING_ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "ING_ENR_REVIEWED1", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      { reconciliation: [row] },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(0);
    expect(receipt.proof.semanticV2LineageProven).toBe(false);
  });

  it("does not grant reviewed authority when canonicalId is not ING_ENR_", () => {
    const row = {
      sourceId: "SPRING_ONION", canonicalId: "GREEN_ONION",
      resolution: "reviewed_new_canonical_id",
      review: { basis: "manual review", evidenceReference: "fixture://1" },
    };
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "GREEN_ONION")).toBe(false);
    const receipt = summarize(
      [prod({ ingredient_id: "SPRING_ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "GREEN_ONION", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      { reconciliation: [row] },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain("fixture://1");
    expect(JSON.stringify(receipt)).not.toContain("manual review");
  });

  it("grants a reviewed ING_ENR_ bridge only with basis and evidenceReference", () => {
    const row = {
      sourceId: "SPRING_ONION", canonicalId: "ING_ENR_REVIEWED1",
      resolution: "reviewed_new_canonical_id",
      review: { basis: "manual reviewed identity", evidenceReference: "fixture://review/1" },
    };
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "ING_ENR_REVIEWED1")).toBe(true);
    const receipt = summarize(
      [prod({ ingredient_id: "SPRING_ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "ING_ENR_REVIEWED1", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      { reconciliation: [row] },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(1);
    expect(receipt.semanticComparison.authoritativeMatches).toBe(1);
    expect(receipt.runtimePositionAuthority).toBe(false);
    expect(receipt.proof.ingestionPipelineProven).toBe(false);
    expect(receipt.researchV2LineageProven).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("manual reviewed identity");
    expect(JSON.stringify(receipt)).not.toContain("fixture://review/1");
    assertCountInvariant(receipt, 1);
  });

  it("does not bridge existing_canonical_id rows with null sourceId", () => {
    const row = { sourceId: null, canonicalId: "GREEN_ONION", resolution: "existing_canonical_id", review: null };
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "GREEN_ONION")).toBe(false);
  });

  it("bridges existing_canonical_id only with a distinct non-empty sourceId", () => {
    const row = { sourceId: "SPRING_ONION", canonicalId: "GREEN_ONION", resolution: "existing_canonical_id", review: null };
    expect(isExistingCanonicalAuthority(row)).toBe(true);
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "GREEN_ONION")).toBe(true);
    const receipt = summarize(
      [prod({ ingredient_id: "SPRING_ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "GREEN_ONION", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      { reconciliation: [row] },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(1);
    expect(receipt.runtimePositionAuthority).toBe(false);
    assertCountInvariant(receipt, 1);
  });

  it("does not grant existing_canonical_id authority when review is present", () => {
    const row = {
      sourceId: "SPRING_ONION", canonicalId: "GREEN_ONION",
      resolution: "existing_canonical_id",
      review: { basis: "fake", evidenceReference: "fake://1" },
    };
    expect(isExistingCanonicalAuthority(row)).toBe(false);
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "GREEN_ONION")).toBe(false);
    const receipt = summarize(
      [prod({ ingredient_id: "SPRING_ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "GREEN_ONION", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      { reconciliation: [row] },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(0);
    expect(receipt.proof.semanticV2LineageProven).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("fake://1");
    expect(JSON.stringify(receipt)).not.toContain("fake");
    assertCountInvariant(receipt, 1);
  });

  it("does not grant existing_canonical_id authority from an empty review object", () => {
    const row = {
      sourceId: "SPRING_ONION", canonicalId: "GREEN_ONION",
      resolution: "existing_canonical_id", review: {},
    };
    expect(isExistingCanonicalAuthority(row)).toBe(false);
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "GREEN_ONION")).toBe(false);
    const receipt = summarize(
      [prod({ ingredient_id: "SPRING_ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "GREEN_ONION", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      { reconciliation: [row] },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(0);
    expect(receipt.proof.semanticV2LineageProven).toBe(false);
    assertCountInvariant(receipt, 1);
  });

  it("does not treat same-id existing_canonical_id as a bridge", () => {
    const row = { sourceId: "GREEN_ONION", canonicalId: "GREEN_ONION", resolution: "existing_canonical_id", review: null };
    expect(isExistingCanonicalAuthority(row)).toBe(false);
  });

  it("does not grant bridge authority from duplicate_alias", () => {
    const row = { sourceId: "SPRING_ONION", canonicalId: "GREEN_ONION", resolution: "duplicate_alias", review: null };
    expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "GREEN_ONION")).toBe(false);
    const receipt = summarize(
      [prod({ ingredient_id: "SPRING_ONION", name: "Hanh la", required_quantity: 1, unit: "bunch" })],
      canonicalOf([v2Line({ ingredientId: "GREEN_ONION", name: "Hanh la", quantity: 1, unit: "bunch", runtimeQuantity: 1, runtimeUnit: "bunch" })]),
      [{ id: "r1", version: 2 }],
      { reconciliation: [row] },
    );
    expect(receipt.semanticComparison.reconciliationProvenMatches).toBe(0);
  });

  it("does not grant bridge authority from ambiguous or invalid resolutions", () => {
    for (const resolution of ["ambiguous", "invalid"]) {
      const row = { sourceId: "SPRING_ONION", canonicalId: "GREEN_ONION", resolution, review: null };
      expect(loadReconciliationAuthority([row]).canBridge("SPRING_ONION", "GREEN_ONION")).toBe(false);
    }
  });

});
