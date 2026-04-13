# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## App: Fantasy Football Dashboard (artifacts/api-server)

**League:** The Derk League — 14-team Dynasty SuperFlex Full PPR (ID: 1312890569210478592)

### Architecture
- Express server proxying Sleeper API + FantasyCalc dynasty SuperFlex rankings
- Single-file frontend: `artifacts/api-server/public/index.html` (~2900 lines)
- Server port: 8080; AI model: claude-sonnet-4-20250514 (Anthropic)
- Routes: `chat.ts`, `find-trades.ts`, `analyze-trade.ts`, `fantasycalc.ts`, `league.ts`, `analyze.ts`

### Key Features
- **Multi-user:** 14 league members select their team on login
- **Tabs:** My Team (AI chat/analysis), League Home, All Teams, Trade Analyzer, Waiver Wire
- **Player values:** FantasyCalc dynasty SuperFlex `includePickValues=true` + KTC fallback
- **Asset Trajectory badges (▲▼→):** Rising (age≤25 or FC trend30Day≥300), Declining (age≥30 or IR/PUP/Sus), Stable (else) — shown on every player row and proposal
- **Team Archetypes (8 types):** Dynasty Contender🏆 / Win Now⚡ / Aging Contender⚠️ / Rising Contender🚀 / Middle of Pack📈 / Strategic Rebuilder🔨 / Accidental Rebuilder😬 / Transitioning🔄 — auto-detected using league value rank + starter age + young depth + transitioning profile + declining key players; hardcoded overrides for "The Derk Knights"→strategicrebuilder, "Vol_Hall_a"→middlepack, "Deaunuts"→dynastycontender; user-overridable in My Team dropdown (localStorage `archetype_override`); complementary archetype pairs (e.g. Win Now↔Strategic Rebuilder) boosted in Find A Trade matching
- **Pick Values (adjusted for 14-team SF):** Adjusted pick value table: Early 1st=8500, Mid 1st=7000, Late 1st=5500; Early 2nd=4000, Mid 2nd=3000, Late 2nd=2200; etc. Slot-aware labels: shows "2026 1.02 (Early 1st)" when draft order known, else "2026 Mid 1st". `G.teamValueRanks` computed post-phase2 for rank-aware archetype detection.
- **Find A Trade (bidirectional):** server-side profiles for all 14 teams; gives/gets mode; archetypeFit in proposals
- **Trade Analyzer:** manual two-team analysis; trajectoryNote + archetypeFit in result
- **AI Chat:** team-mode aware (My Team only); includes roster, waiver wire, archetype in system prompt

### localStorage Keys
- `selectedUsername` — chosen league member
- `archetype_override` — manual archetype override (contender/rebuilder/middlepack/agingcontender/empty)

### Commissioner
- Owner ID `524644433167802368` (DHall5/Vol_Hall_a, roster_id 8) — gold badge UI only
