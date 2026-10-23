# Repository Guidelines

## Project Structure & Module Organization

AI StockTrader is a Next.js App Router application for mock trading, backed by PostgreSQL and Clerk authentication.

- `app/`: pages, layouts, styles, and API handlers under `app/api/**/route.ts`.
- `components/`: React UI components; `context/` holds shared account state.
- `lib/`: shared types and helpers; `lib/server/` contains database access, market data, AI analysis, and trading logic. Tests sit beside their modules.
- `db/schema.sql` and `db/migrations/`: database initialization and numbered SQL upgrades.
- `public/`: static assets. Root configuration files control Next.js, TypeScript, ESLint, and Tailwind.

Use these active directories; legacy `client/` and `server/` directories are excluded from TypeScript and ESLint.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run dev`: start the application and API at `http://localhost:3000`.
- `npm run build`: create a production build; `npm start` serves it.
- `npm run lint`: run ESLint with Next.js Core Web Vitals and TypeScript rules.
- `npm run typecheck`: check strict TypeScript types without emitting code.
- `npm test`: run the configured unit tests through Node's test runner and `tsx`.

Configure `.env.local` and PostgreSQL using `README.md` before running locally. Apply database upgrades in numbered order.

## Coding Style & Naming Conventions

Follow surrounding formatting: application TypeScript generally uses four-space indentation, double quotes, and semicolons; configuration files commonly use two spaces. Use PascalCase component filenames, camelCase functions and helpers, and Next.js filenames such as `page.tsx` and `route.ts`. Prefer `@/` imports for shared modules and explicit TypeScript types. Add `"use client"` where client behavior requires it. ESLint is configured; no standalone formatter is configured.

## Testing Guidelines

Use `node:test` and `node:assert/strict` in colocated `*.test.ts` files. Cover calculation boundaries, order transitions, and market-calendar behavior with deterministic inputs. Add new test files to the explicit list in `package.json`. No coverage threshold is configured. Run tests, lint, and typecheck before submitting; verify UI changes locally.

## Commit & Pull Request Guidelines

History uses short descriptive subjects, such as `Migrate to Next.js and TypeScript`; no mandatory Conventional Commits prefix is evident. Keep commits focused. PRs should explain the behavior change, link relevant issues, report validation, and include screenshots for UI changes. Document migrations and configuration changes.

## Security & Configuration

Keep secrets in gitignored `.env.local`. Keep API credentials and AI prompts server-side, scope account queries by authenticated user, and preserve server-authoritative trade prices. Add schema upgrades as numbered migrations.
