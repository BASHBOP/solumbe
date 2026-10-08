# 2026-10-08: alias imports and joined product names

Found while shipping OpenPanel analytics across bashbop-event-web (#622), bashbop-mobile-app (#25) and bashbop-api (#557).

## Misses

1. `convergence_score` on the web change (`33067bf4..2eff58ed`): 51/100 (partial), scope 16.
   - 25 changed files counted as drift, among them `GuestsTable.tsx`, `BroadcastDialog.tsx`, `openpanel-provider.tsx` and their tests.
   - Each one gained `import { analytics } from '@/utils/analytics'`, and `utils/analytics.ts` was a confirmed owner.
2. `context_pack` on the mobile app for "identify the signed-in account in OpenPanel and track ticket scans and guest check-ins":
   - Expected primary: `lib/openpanel.ts`. It ranked ninth.
   - `change_impact` left it out of its top twelve.

## Cause

1. `importedFiles` in `converge.js` resolved relative specifiers only. `resolveImportSpecifier` in `ranking-rules.js` already understood `@/`, `~/` and `#/`, but the convergence rules did not use it.
2. The tokenizer splits "OpenPanel" into `open` and `panel`. `compoundPartners` stops those words matching on their own, but nothing matched the joined `openpanel` that file names and package scopes use. In a large app, `open` and `panel` are common words, so their weight is low.

## Fix

- `importedFiles` resolves through `resolveImportSpecifier`, now exported. The convergence engine moves to `0.5.0`.
- `joinedCamelCaseWords` (in `code-map/text.js`) adds the joined spelling as a query term in `context_pack` and `change_impact`.

## After

- The web change scores 69/100, with scope 68 and 10 drift files.
  - Six of them are risk-flagged by design (login forms, pricing, subscription, BVN, payout).
  - Four changed without adding an import (`create-event.tsx`, `RsvpByEventId.tsx`, `web-vitals-analytics.tsx`, `hooks/useAnalytics.ts`).
- On the mobile request, `lib/openpanel.ts` is third in `context_pack` and eighth in `change_impact`.

## Not fixed

- `change_impact` still ranks `lib/bookingTicket.ts` and `types/waitlist.ts` above the scanner files for "track ticket scans". `scans` does not match `scanner`/`useScanner`, a stemming gap in the impact engine.
- In bashbop-api #557, the change was one `select` in `user.service.ts`. `convergence_score` also predicted `auth.controller.ts`, `auth.module.ts` and `paystack.controller.ts`, which did not need to change, so coverage was 25 (66/100 overall).
  - Counting a predicted controller as covered when it calls the changed service would also hide a task that needed both, so this was left for a decision.

## Regression tests

- `tests/converge.test.js`: "inferInScopeFiles follows root-alias imports to a confirmed file".
- `tests/context-engine.test.js`: "generateContextPack reaches a file named with the joined spelling of a camelCase name", plus a `joinedCamelCaseWords` test.
- `tests/impact.test.js`: "weightedQueryTerms also weighs the joined spelling of a camelCase name".

No corpus fixture. Both misses need a large repository to reproduce. In a small fixture, the impact engine's own import graph already links a caller to its owner, and `open`/`panel` are rare enough to score, so a fixture passed with or without the fix.
