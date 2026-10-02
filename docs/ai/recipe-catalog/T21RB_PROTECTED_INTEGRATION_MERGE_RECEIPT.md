# T21R-B protected V1 diagnostic integration merge receipt

Status: `T21RB_PROTECTED_INTEGRATION_MERGED`; integration and CI are complete,
but no production V1 snapshot has been captured.

## Repository and review

- Repository authority: GitHub repository ID `1385308553`, resolved as
  `vn-tako4/Tako-san` at verification.
- Base main before merge: `3e0f6531b98feb1e44743513b91aff131bbd522b`.
- Reviewed head: `0b28b48e2fbd8f4892ddbf57ae9139d96addc0a3` on
  `codex/t21rb-offline-semantic-snapshot`.
- PR: `#33`, merged through the protected PR flow at
  `2026-10-01T21:55:51Z`.
- Application merge commit: `483e054b8ad5e0391aaedfcaf65343ce95949562`.
- An independent read-only agent review found no concrete correctness,
  workflow-guard or receipt-privacy issue. Its remaining test limitation is
  that the production wrapper unit tests inject a synthetic comparison rather
  than running a full production-wrapper CLI fixture; separate real-catalog
  comparator tests and an offline CLI smoke passed.

## CI evidence

- PR exact-head CI run `36931130799`: `validate` SUCCESS on
  `0b28b48e2fbd8f4892ddbf57ae9139d96addc0a3`.
- Exact-main CI run `36931887016`: `validate` SUCCESS on
  `483e054b8ad5e0391aaedfcaf65343ce95949562`.
- Both hosted runs passed installation, ESLint, typecheck, Vitest, local
  migration smoke and Web/Worker build. Prior local verification on the
  implementation checkpoint passed 225 Vitest files / 4,906 tests twice,
  focused 23/23, lint, typecheck, migration smoke, build and diff check.
- The CI workflow is validation-only. No production diagnostic workflow was
  dispatched by these runs.

## Evidence boundary and next gate

The manual read-only workflow is now present on main. It remains gated by an
exact-current-main SHA and CI proof, production Environment review, Cloudflare
account/D1 identity, ledger checks and a final main-SHA recheck. Its V1 receipt
will describe two observed equal five-statement reads as
`OBSERVED_STABLE_NON_ATOMIC`; it cannot certify an atomic snapshot or the
uncompared catalog dimensions. No production read, SQL mutation, restore,
0039 apply, flag change or deploy occurred during this merge.

`T21G_NOT_READY`; `repairAuthorized=false`; 0039 and production deploy remain
stopped. The next decision is a separately authorized manual read-only
production diagnostic dispatch at an exact current-main SHA. Review only the
sanitized V1 receipt and plan a protected row-evidence path for unresolved
occurrences before any T21G repair design.
