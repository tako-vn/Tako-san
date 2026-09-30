import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DB = { name: "frigo-db", id: "f975ec39-b2c8-4a2a-80e1-0366054599d3" };
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const HISTORICAL_TIP = "0038_auth_onboarding_completion.sql";
const CANDIDATE_TIP = "0039_meal_composition_v2.sql";
const V2_ROOT = ["data", "recipe-refresh", "v2"];
const DEFAULT_RECIPES = 500;
const DEFAULT_LINES = 6766;

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rows(statement, label) {
  if (statement?.success !== true || !Array.isArray(statement.results)) {
    throw new Error(label + " proof is incomplete");
  }
  return statement.results;
}

export function normalizeText(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/gu, " ") : "";
}

function optionalBit(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

export function fingerprintCanonicalArtifact(entries) {
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new Error("duplicate canonical artifact path");
  if (entries.some((entry, index) => index > 0 && entry.path <= entries[index - 1].path)) {
    throw new Error("canonical artifact paths must be strictly sorted");
  }
  for (const entry of entries) {
    if (!entry.path || entry.path.startsWith("/") || entry.path.includes("..") || entry.path.includes("\\")) {
      throw new Error("invalid canonical artifact path");
    }
    if (!HASH.test(entry.sha256)) throw new Error("invalid canonical artifact SHA-256");
  }
  return createHash("sha256").update(entries.map((entry) => entry.path + "\0" + entry.sha256).join("\n")).digest("hex");
}

function canonicalLine(recipeId, ingredient) {
  const quantity = ingredient?.quantity && typeof ingredient.quantity === "object" && !Array.isArray(ingredient.quantity)
    ? ingredient.quantity : {};
  const optional = optionalBit(ingredient?.optional);
  const name = typeof ingredient?.sourceName === "string" ? ingredient.sourceName : "";
  const ingredientId = typeof ingredient?.canonicalIngredientId === "string" ? ingredient.canonicalIngredientId : "";
  if (!name || !ingredientId || optional === null || !Number.isInteger(ingredient?.position) || ingredient.position < 0) {
    throw new Error("Canonical V2 ingredient line is invalid");
  }
  const runtime = quantity.runtime && typeof quantity.runtime === "object" && !Array.isArray(quantity.runtime)
    ? quantity.runtime : null;
  return {
    recipeId,
    position: ingredient.position,
    ingredientId,
    name,
    quantity: quantity.kind === "measured" && Number.isFinite(quantity.amount) ? quantity.amount : null,
    unit: typeof quantity.unit === "string" ? quantity.unit : "",
    optional,
    runtimeQuantity: runtime && Number.isFinite(runtime.amount) ? runtime.amount : null,
    runtimeUnit: typeof runtime?.unit === "string" ? runtime.unit : "",
    usageRole: typeof ingredient.usageRole === "string" ? ingredient.usageRole : "unknown",
    includeInShopping: ingredient.includeInShopping === true,
    quantityKind: typeof quantity.kind === "string" ? quantity.kind : "unknown",
    evidence: typeof quantity.evidence === "string" ? quantity.evidence : "",
  };
}

export function loadCanonicalV2Source({
  cwd = process.cwd(),
  expectedRecipeCount = DEFAULT_RECIPES,
  expectedLineCount = DEFAULT_LINES,
} = {}) {
  const root = path.join(cwd, ...V2_ROOT);
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (manifest.sourceStatus !== "RECIPE_REFRESH_V2_RESEARCH_CANONICALIZED"
      || manifest.recipeCount !== expectedRecipeCount
      || !Array.isArray(manifest.fileHashes) || !HASH.test(manifest.canonicalArtifactSha256)) {
    throw new Error("Canonical Recipe Refresh V2 manifest is not the reviewed package");
  }
  const hashed = manifest.fileHashes.map((entry) => {
    if (!entry?.path || !HASH.test(entry.sha256)) throw new Error("Canonical artifact hash list is invalid");
    const sha256 = createHash("sha256").update(readFileSync(path.join(root, entry.path))).digest("hex");
    if (sha256 !== entry.sha256) throw new Error("Canonical Recipe Refresh V2 source hash drift");
    return { path: entry.path, sha256 };
  });
  const artifactSha256 = fingerprintCanonicalArtifact(hashed);
  if (artifactSha256 !== manifest.canonicalArtifactSha256) {
    throw new Error("Canonical Recipe Refresh V2 artifact fingerprint drift");
  }
  const recipeDir = path.join(root, "recipes");
  const files = readdirSync(recipeDir).filter((name) => name.endsWith(".json")).sort();
  if (files.length !== expectedRecipeCount) throw new Error("Canonical V2 recipe file count is not the reviewed catalog");
  const lines = [];
  const recipeIds = [];
  for (const file of files) {
    const recipe = JSON.parse(readFileSync(path.join(recipeDir, file), "utf8"));
    const id = recipe?.identity?.id;
    if (typeof id !== "string" || !id || id + ".json" !== file) throw new Error("Canonical V2 recipe identity is invalid");
    if (recipe.recipeVersion !== 2 || recipe.schemaVersion !== 2) throw new Error("Canonical V2 recipe version is invalid");
    if (!Array.isArray(recipe.ingredients)) throw new Error("Canonical V2 ingredients are invalid");
    recipeIds.push(id);
    for (const [index, ingredient] of recipe.ingredients.entries()) {
      if (ingredient?.position !== index) throw new Error("Canonical V2 ingredient positions are not contiguous");
      lines.push(canonicalLine(id, ingredient));
    }
  }
  if (lines.length !== expectedLineCount) throw new Error("Canonical V2 line count is not the reviewed source");
  if (new Set(recipeIds).size !== expectedRecipeCount) throw new Error("Canonical V2 recipe IDs are not unique");
  return {
    lines,
    recipeIds,
    recipeCount: expectedRecipeCount,
    lineCount: lines.length,
    artifactSha256,
    sourceStatus: manifest.sourceStatus,
    productionReleaseReady: manifest.releaseEligibility?.productionReleaseReady === true,
    runtimeProjectionReady: manifest.releaseEligibility?.runtimeProjectionReady === true,
    blockers: Array.isArray(manifest.releaseEligibility?.blockers) ? [...manifest.releaseEligibility.blockers] : [],
  };
}

export function parseProductionIngredientLine(row) {
  const optional = optionalBit(row?.is_optional);
  if (!row || typeof row !== "object" || Array.isArray(row)
      || typeof row.id !== "string" || !row.id
      || typeof row.recipe_id !== "string" || !row.recipe_id
      || typeof row.ingredient_id !== "string" || !row.ingredient_id
      || typeof row.name !== "string" || !row.name
      || typeof row.unit !== "string"
      || !Number.isFinite(row.required_quantity) || row.required_quantity <= 0
      || optional === null) {
    return null;
  }
  return {
    recipeId: row.recipe_id,
    ingredientId: row.ingredient_id,
    name: row.name,
    quantity: row.required_quantity,
    unit: row.unit,
    optional,
  };
}

function sourceExactKey(line) {
  return JSON.stringify([line.recipeId, line.ingredientId, line.name, line.quantity, line.unit, line.optional]);
}

function sourceNormalizedKey(line) {
  return JSON.stringify([
    line.recipeId, line.ingredientId, normalizeText(line.name).toLowerCase(),
    line.quantity, normalizeText(line.unit).toLowerCase(), line.optional,
  ]);
}

function contentNormalizedKey(line) {
  return JSON.stringify([
    line.recipeId, normalizeText(line.name).toLowerCase(),
    line.quantity, normalizeText(line.unit).toLowerCase(), line.optional,
  ]);
}

function runtimeExactKey(line) {
  return JSON.stringify([
    line.recipeId, line.ingredientId, line.name, line.runtimeQuantity, line.runtimeUnit, line.optional,
  ]);
}

function runtimeNormalizedKey(line) {
  return JSON.stringify([
    line.recipeId, normalizeText(line.name).toLowerCase(),
    line.runtimeQuantity, normalizeText(line.runtimeUnit).toLowerCase(), line.optional,
  ]);
}

function bagBy(lines, keyFn) {
  const map = new Map();
  for (const line of lines) {
    const key = keyFn(line);
    const bucket = map.get(key);
    if (bucket) bucket.push(line);
    else map.set(key, [line]);
  }
  return map;
}

function identitySet(lines) {
  return new Set(lines.map(sourceExactKey)).size;
}

function assignBags(prodRemaining, v2Remaining, prodKeyFn, v2KeyFn, kind, { requireInterchangeable = false } = {}) {
  const prodBags = bagBy(prodRemaining, prodKeyFn);
  const v2Bags = bagBy(v2Remaining, v2KeyFn);
  const matched = [];
  const ambiguousProd = [];
  const ambiguousV2 = [];
  const usedProd = new Set();
  const usedV2 = new Set();

  for (const [key, prods] of prodBags) {
    const v2s = v2Bags.get(key);
    if (!v2s) continue;
    if (requireInterchangeable && identitySet(v2s) > 1) {
      for (const line of prods) { ambiguousProd.push(line); usedProd.add(line); }
      for (const line of v2s) { ambiguousV2.push(line); usedV2.add(line); }
      continue;
    }
    const n = Math.min(prods.length, v2s.length);
    const positionUnique = prods.length === 1 && v2s.length === 1;
    for (let index = 0; index < n; index += 1) {
      matched.push({ production: prods[index], v2: v2s[index], kind, positionUnique });
      usedProd.add(prods[index]);
      usedV2.add(v2s[index]);
    }
  }

  return {
    matched,
    ambiguousProd,
    ambiguousV2,
    nextProd: prodRemaining.filter((line) => !usedProd.has(line)),
    nextV2: v2Remaining.filter((line) => !usedV2.has(line)),
  };
}

export function missingCanonicalReason(line) {
  if (line.quantityKind === "qualitative") return "qualitative_quantity";
  if (line.usageRole === "process_only") return "process_only";
  if (line.usageRole === "mixed_process") return line.evidence === "estimated" ? "estimated_process" : "process_only";
  if (line.includeInShopping === false) return "non_shopping";
  if (line.runtimeQuantity === null && line.quantityKind === "measured") return "no_runtime_quantity";
  return "unknown";
}

function countVersions(recipes) {
  const ids = new Set();
  const versions = { v1: 0, v2: 0, other: 0 };
  for (const recipe of recipes) {
    if (typeof recipe?.id !== "string" || !recipe.id || ids.has(recipe.id)) {
      throw new Error("Recipe identity proof is invalid");
    }
    ids.add(recipe.id);
    if (recipe.version === 1) versions.v1 += 1;
    else if (recipe.version === 2) versions.v2 += 1;
    else versions.other += 1;
  }
  return { ids, versions };
}

function classifyRecipe(stats) {
  if (stats.productionLines > 0 && stats.exact + stats.normalized === 0) return "NO_MATCH";
  if (stats.ambiguous > 0) return "AMBIGUOUS";
  if (stats.productionOnly > 0) return "SEMANTIC_DRIFT";
  if (stats.missing > 0) {
    return stats.unexplainedMissing > 0 ? "SEMANTIC_DRIFT" : "V2_SUBSET_WITH_PROVEN_MISSING_LINES";
  }
  if (stats.exact + stats.normalized === stats.productionLines && stats.productionLines === stats.v2Lines) {
    return "EXACT_V2_RECIPE";
  }
  return "SEMANTIC_DRIFT";
}

export function summarizeV2CatalogLineage({
  manifest, before, after, runtime, orderCoverage, canonical, checkedAt = new Date().toISOString(),
}) {
  if (manifest?.environment !== "production" || !SHA.test(manifest.sha || "")
      || manifest.mainSha !== manifest.sha || manifest.cloudflare?.databaseName !== DB.name
      || manifest.cloudflare?.databaseId !== DB.id || !canonical
      || canonical.recipeCount !== canonical.recipeIds.length) {
    throw new Error("Exact-main production D1 identity or canonical V2 source proof is incomplete");
  }
  const pre = rows(before?.[0], "Pre-ledger").map((row) => row?.name);
  const post = rows(after?.[0], "Post-ledger").map((row) => row?.name);
  const expectedLedger = manifest.schema.migrations.slice(0, 38).map((entry) => entry.name);
  if (before.length !== 1 || after.length !== 1 || JSON.stringify(pre) !== JSON.stringify(expectedLedger)
      || JSON.stringify(post) !== JSON.stringify(pre) || pre.at(-1) !== HISTORICAL_TIP
      || manifest.schema.migrations[38]?.name !== CANDIDATE_TIP) {
    throw new Error("Production ledger is not stable at exact historical 0038");
  }
  if (!Array.isArray(runtime) || runtime.length !== 5) throw new Error("Runtime catalog proof needs five SELECT results");
  const recipes = rows(runtime[0], "Recipe");
  const actualRows = rows(runtime[1], "Ingredient");
  for (const [index, statement] of runtime.entries()) rows(statement, "Runtime SELECT " + (index + 1));
  const coverageRows = rows(orderCoverage?.[0], "Order coverage");
  if (orderCoverage.length !== 1 || coverageRows.length !== 1) throw new Error("Order coverage proof is incomplete");
  const coverage = coverageRows[0];
  const { ids: recipeIds, versions } = countVersions(recipes);
  const canonicalRecipeIds = new Set(canonical.recipeIds);
  if (canonicalRecipeIds.size !== canonical.recipeCount) throw new Error("Canonical V2 recipe identity proof is invalid");
  const liveOnlyRecipes = [...recipeIds].filter((id) => !canonicalRecipeIds.has(id)).length;
  const absentCanonicalRecipes = [...canonicalRecipeIds].filter((id) => !recipeIds.has(id)).length;

  const production = [];
  let malformed = 0;
  const seenProductionIds = new Set();
  for (const row of actualRows) {
    if (typeof row?.id === "string" && row.id) {
      if (seenProductionIds.has(row.id)) throw new Error("Production has duplicate ingredient line IDs");
      seenProductionIds.add(row.id);
    }
    const parsed = parseProductionIngredientLine(row);
    if (!parsed) { malformed += 1; continue; }
    if (!recipeIds.has(parsed.recipeId)) throw new Error("Ingredient line references an unknown recipe");
    production.push(parsed);
  }
  if (coverage.ingredient_rows !== actualRows.length) {
    throw new Error("Ingredient comparison counts disagree with the D1 aggregate");
  }

  const v2Lines = canonical.lines;
  let prodRemaining = production;
  let v2Remaining = v2Lines;
  const matched = [];
  const ambiguousProd = [];
  const ambiguousV2 = [];
  const passes = [
    { prodKey: sourceExactKey, v2Key: sourceExactKey, kind: "exact", requireInterchangeable: false },
    { prodKey: sourceExactKey, v2Key: runtimeExactKey, kind: "exact-runtime", requireInterchangeable: false },
    { prodKey: sourceNormalizedKey, v2Key: sourceNormalizedKey, kind: "normalized", requireInterchangeable: true },
    { prodKey: contentNormalizedKey, v2Key: contentNormalizedKey, kind: "normalized", requireInterchangeable: true },
    { prodKey: contentNormalizedKey, v2Key: runtimeNormalizedKey, kind: "normalized", requireInterchangeable: true },
  ];
  for (const pass of passes) {
    const result = assignBags(prodRemaining, v2Remaining, pass.prodKey, pass.v2Key, pass.kind, {
      requireInterchangeable: pass.requireInterchangeable,
    });
    matched.push(...result.matched);
    ambiguousProd.push(...result.ambiguousProd);
    ambiguousV2.push(...result.ambiguousV2);
    prodRemaining = result.nextProd;
    v2Remaining = result.nextV2;
  }

  const exactMatches = matched.filter((row) => row.kind === "exact" || row.kind === "exact-runtime").length;
  const exactSourceMatches = matched.filter((row) => row.kind === "exact").length;
  const exactRuntimeMatches = matched.filter((row) => row.kind === "exact-runtime").length;
  const normalizedMatches = matched.filter((row) => row.kind === "normalized").length;
  const uniquelyMappedLines = matched.filter((row) => row.positionUnique).length;
  const ambiguousPositionLines = matched.filter((row) => !row.positionUnique).length + ambiguousProd.length;
  const productionOnly = prodRemaining.length;
  const missingV2 = v2Remaining;
  const ambiguousMatches = ambiguousProd.length;

  const missingReasons = {};
  let unexplainedMissing = 0;
  for (const line of missingV2) {
    const reason = missingCanonicalReason(line);
    missingReasons[reason] = (missingReasons[reason] ?? 0) + 1;
    if (reason === "unknown") unexplainedMissing += 1;
  }

  const recipeStats = new Map();
  for (const id of new Set([...recipeIds, ...canonicalRecipeIds])) {
    recipeStats.set(id, {
      productionLines: 0, v2Lines: 0, exact: 0, normalized: 0, ambiguous: 0,
      productionOnly: 0, missing: 0, unexplainedMissing: 0, uniqueOrder: 0, orderAmbiguous: 0,
    });
  }
  for (const line of production) recipeStats.get(line.recipeId).productionLines += 1;
  for (const line of v2Lines) recipeStats.get(line.recipeId).v2Lines += 1;
  for (const row of matched) {
    const stats = recipeStats.get(row.production.recipeId);
    if (row.kind === "normalized") stats.normalized += 1;
    else stats.exact += 1;
    if (row.positionUnique) stats.uniqueOrder += 1;
    else stats.orderAmbiguous += 1;
  }
  for (const line of ambiguousProd) recipeStats.get(line.recipeId).ambiguous += 1;
  for (const line of prodRemaining) recipeStats.get(line.recipeId).productionOnly += 1;
  for (const line of missingV2) {
    const stats = recipeStats.get(line.recipeId);
    stats.missing += 1;
    if (missingCanonicalReason(line) === "unknown") stats.unexplainedMissing += 1;
  }

  const recipeClasses = { EXACT_V2_RECIPE: 0, V2_SUBSET_WITH_PROVEN_MISSING_LINES: 0, SEMANTIC_DRIFT: 0, AMBIGUOUS: 0, NO_MATCH: 0 };
  let recipesWithUniqueOrderMapping = 0;
  let recipesWithOrderAmbiguity = 0;
  for (const stats of recipeStats.values()) {
    recipeClasses[classifyRecipe(stats)] += 1;
    if (stats.productionLines > 0 && stats.uniqueOrder === stats.productionLines && stats.ambiguous === 0) {
      recipesWithUniqueOrderMapping += 1;
    }
    if (stats.orderAmbiguous > 0 || stats.ambiguous > 0) recipesWithOrderAmbiguity += 1;
  }

  const recipeIdSetMatches = liveOnlyRecipes === 0 && absentCanonicalRecipes === 0 && recipeIds.size === canonical.recipeCount;
  const productionIsExactCanonicalV2 = malformed === 0 && productionOnly === 0 && ambiguousMatches === 0
    && missingV2.length === 0 && exactMatches + normalizedMatches === production.length
    && production.length === canonical.lineCount;
  const productionIsSemanticSubsetOfCanonicalV2 = malformed === 0 && productionOnly === 0 && ambiguousMatches === 0
    && exactMatches + normalizedMatches === production.length && production.length > 0;
  const missingLinesFullyExplained = unexplainedMissing === 0;
  const uniquePositionAuthorityAvailable = productionIsSemanticSubsetOfCanonicalV2
    && uniquelyMappedLines === production.length && recipesWithOrderAmbiguity === 0;
  const semanticV2LineageProven = productionIsSemanticSubsetOfCanonicalV2;

  let status = "V2_LINEAGE_UNRESOLVED";
  if (productionOnly > 0) status = "PRODUCTION_LIVE_SOURCE_UNRESOLVED";
  else if (ambiguousMatches > 0) status = "V2_LINEAGE_PARTIAL";
  else if (semanticV2LineageProven) status = "V2_SEMANTIC_LINEAGE_PROVEN";
  else if (exactMatches + normalizedMatches > 0) status = "V2_LINEAGE_PARTIAL";

  let positionAuthority = "NONE";
  if (uniquePositionAuthorityAvailable) positionAuthority = "CANONICAL_V2_ORDER_CANDIDATE";
  else if (semanticV2LineageProven) positionAuthority = "PARTIAL";

  if (exactMatches + normalizedMatches + productionOnly + ambiguousMatches !== production.length
      || exactMatches + normalizedMatches + missingV2.length + ambiguousV2.length !== v2Lines.length) {
    throw new Error("V2 ingredient comparison counts disagree");
  }

  return {
    schemaVersion: 1,
    status,
    certification: "NOT_A_RELEASE_CERTIFICATION",
    readOnly: true,
    productionMutations: [],
    candidateSha: manifest.sha,
    checkedAt,
    database: DB,
    ledger: { count: pre.length, tip: pre.at(-1) },
    semanticLineKey: {
      exact: ["recipe_id", "ingredient_id", "name", "required_quantity", "unit", "is_optional"],
      canonicalExact: ["identity.id", "canonicalIngredientId", "sourceName", "quantity.amount", "quantity.unit", "optional"],
      normalized: ["NFKC", "trim", "collapse_whitespace", "casefold_name_and_unit"],
      runtimeExact: ["quantity.runtime.amount", "quantity.runtime.unit"],
    },
    canonicalV2: {
      artifactSha256: canonical.artifactSha256,
      recipeCount: canonical.recipeCount,
      lineCount: canonical.lineCount,
      productionReleaseReady: canonical.productionReleaseReady === true,
      runtimeProjectionReady: canonical.runtimeProjectionReady === true,
      aggregateSha256: digest(v2Lines.map((line) => [
        line.recipeId, line.position, line.ingredientId, line.name, line.quantity, line.unit, line.optional,
      ])),
    },
    production: {
      recipeCount: recipeIds.size,
      recipeVersions: versions,
      lineCount: actualRows.length,
      parsedLineCount: production.length,
      orderRows: coverage.order_rows,
      missingOrderRows: coverage.ingredients_without_matching_order,
      aggregateSha256: digest(production.map((line) => [
        line.recipeId, line.ingredientId, line.name, line.quantity, line.unit, line.optional,
      ]).sort()),
    },
    semanticComparison: {
      exactMatches,
      exactSourceMatches,
      exactRuntimeMatches,
      normalizedMatches,
      ambiguousMatches,
      productionOnly,
      malformed,
    },
    canonicalCoverage: {
      matched: exactMatches + normalizedMatches,
      missing: missingV2.length,
      ambiguous: ambiguousV2.length,
    },
    recipes: {
      total: recipeStats.size,
      exactV2Recipes: recipeClasses.EXACT_V2_RECIPE,
      subsetRecipes: recipeClasses.V2_SUBSET_WITH_PROVEN_MISSING_LINES,
      driftRecipes: recipeClasses.SEMANTIC_DRIFT,
      ambiguousRecipes: recipeClasses.AMBIGUOUS,
      noMatchRecipes: recipeClasses.NO_MATCH,
      liveRecipeIdsNotInCanonical: liveOnlyRecipes,
      canonicalRecipeIdsAbsentFromLive: absentCanonicalRecipes,
    },
    ordering: {
      uniquelyMappedLines,
      ambiguousPositionLines,
      recipesWithUniqueOrderMapping,
      recipesWithOrderAmbiguity,
    },
    missingCanonicalLines: {
      total: missingV2.length,
      unexplained: unexplainedMissing,
      reasonCounts: missingReasons,
    },
    proof: {
      canonicalArtifactVerified: HASH.test(canonical.artifactSha256 || ""),
      recipeIdSetMatches,
      productionIsExactCanonicalV2,
      productionIsSemanticSubsetOfCanonicalV2,
      missingLinesFullyExplained,
      uniquePositionAuthorityAvailable,
      semanticV2LineageProven,
      ingestionPipelineProven: false,
    },
    researchV2LineageProven: false,
    positionAuthority,
  };
}

async function main() {
  const [manifestPath, beforePath, runtimePath, coveragePath, afterPath, receiptPath] = process.argv.slice(2);
  if (!receiptPath || process.argv.length !== 8) {
    throw new Error("Expected manifest, pre-ledger, runtime, order coverage, post-ledger and receipt paths");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const canonical = loadCanonicalV2Source();
  const receipt = summarizeV2CatalogLineage({
    manifest,
    before: JSON.parse(readFileSync(beforePath, "utf8")),
    runtime: JSON.parse(readFileSync(runtimePath, "utf8")),
    orderCoverage: JSON.parse(readFileSync(coveragePath, "utf8")),
    after: JSON.parse(readFileSync(afterPath, "utf8")),
    canonical,
  });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  console.log("Production catalog V2 lineage: " + receipt.status + "; exact=" + receipt.semanticComparison.exactMatches + " normalized=" + receipt.semanticComparison.normalizedMatches);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Production catalog V2 lineage failed before a complete sanitized receipt could be written");
    process.exitCode = 1;
  });
}
