# 2026-10-05: session replay requests on bashbop-event-web

Live repo: `bashbop-event-web` (about 1,900 files), alone and with its `bashbop-api` companion. The fixture `evals/fixtures/telemetry-web` encodes the same shapes at a size where the effect is smaller; see `docs/EVALS.md`.

## Request 1

> session replay / session playback for critical user errors: error tracking, Sentry, PostHog, monitoring, error boundary, global error handler

Expected primary: `components/common/ErrorBoundary.tsx`, `app/global-error.tsx`.

- **Before:**
  - Primary: `middleware/admin-auth.ts`, `utils/api-cache.ts`, `services/ai-credits-service.ts`, `components/common/ErrorBoundary.tsx`, `services/auth-service.ts`.
  - `app/global-error.tsx` was missing from the top 8.
  - Hotspots: `get`, `set`, `clear`, `delete`, `createSession`, `removeSession` and `validateSession`, with `matchedTokens` such as `["session","session","errors","error","error","error"]`. Also `postAiStream`, through `post` from "PostHog".
- **After:**
  - `ErrorBoundary.tsx` is first and `app/global-error.tsx` sixth, inside the default limit of 8.
  - Each hotspot lists a word once, and `post` no longer matches alone.
- **Cause:** every mention of a word counted, so `session` (said twice) turned a one-word method match into a "two-word" match.

## Request 2

> add session replay to the OpenPanel analytics provider

Expected primary: `components/providers/openpanel-provider.tsx` and `app/api/telemetry/[...openpanel]/route.ts`.

- **Before (web + API):**
  - `bashbop-api/src/seller/seller.service.ts` was primary.
  - Hotspots included `createVendorSubscriptionCheckout` `["session","open"]` and `handleCheckoutSessionCompleted` `["add","session"]`.
- **After:** `seller.service.ts` has left the pack, and `route.ts` entered it.
- **Causes:**
  - "OpenPanel" splits into `open` and `panel`, and `open` matched on its own.
  - `add`, the request's action verb, matched a local variable inside a method body.

## Still open

- `utils/api-cache.ts` (`get` with `session` and `errors`) and `components/admin/AdminSupportSessionBanner.tsx` still rank above `app/global-error.tsx`. Here "session" is half of "session replay", which token matching can't tell from login sessions.
- For "session replay", the `bashbop-api` session module (`src/session/session.entity.ts`, `redis-session.service.ts`) still ranks primary for the same reason.
