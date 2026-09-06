# Sauda Jasa — Admin System

Internal admin system for **Sauda Jasa**. This is **not** the public marketplace — it is
the back-office foundation the team uses to manage boutiques, review submissions, and
prepare a Telegram publishing queue. It is built to scale to thousands of boutiques.

> Intentionally **not** included yet: Instagram parser, Telegram integration, and AI.
> The data model and UI reserve space for them, but no such logic ships in this foundation.

---

## Tech stack

| Concern            | Choice                                   |
| ------------------ | ---------------------------------------- |
| Framework          | Next.js 15 (App Router) + TypeScript     |
| Styling            | TailwindCSS + shadcn/ui-style components |
| Auth               | Supabase Auth (SSR, cookie sessions)     |
| Database / ORM     | Postgres (Supabase) + Prisma             |
| Server state       | TanStack Query                           |
| Client/UI state    | Zustand                                  |
| Forms + validation | React Hook Form + Zod                    |
| Tooling            | ESLint, Prettier, Docker                 |

---

## Project structure

```
src/
  app/            # Routes (App Router). Route groups: (auth), (dashboard)
  components/     # Reusable UI
    ui/           # shadcn-style primitives (button, card, input, ...)
    layout/       # Sidebar, top navbar, theme toggle, user nav
    providers/    # Theme + React Query providers
    shared/       # Cross-feature building blocks (stat card, page header, ...)
  features/       # Feature-scoped UI (auth, dashboard, boutiques)
  lib/            # Framework/client setup (supabase, prisma, env, utils, nav)
  services/       # Server-only domain services (Prisma-backed data access)
  server/         # Server-only helpers: auth guards + server actions
  hooks/          # Client hooks (TanStack Query hooks, Zustand store)
  types/          # Shared TypeScript types / DTOs
  utils/          # Pure, framework-agnostic helpers
  middleware.ts   # Route protection + Supabase session refresh
```

### Architecture notes

- **Clean layering.** UI (`app`, `components`, `features`) never touches the database
  directly. It calls `services/` (server-only, Prisma) or route handlers under `app/api`.
- **Two data-fetching patterns, on purpose.** The dashboard is a Server Component that
  calls a service directly. The boutiques list is a Client Component that uses TanStack
  Query against a protected route handler — demonstrating both server and client paths.
- **Real data only.** Dashboard counters are live `prisma.count()` queries. With an empty
  database they read `0`; there is no seeded/mock data.
- **Protected routes.** `middleware.ts` refreshes the Supabase session and redirects
  unauthenticated users to `/login`. Server layouts re-check the user as defense in depth.

---

## Getting started

### 1. Prerequisites

- Node.js `>= 18.18`
- A [Supabase](https://supabase.com) project (for Auth + Postgres)

### 2. Install

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in the values from your Supabase project (see comments in `.env.example`):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Project Settings → API
- `DATABASE_URL`, `DIRECT_URL` — Project Settings → Database → Connection string

### 4. Create an admin user

This is an **admin-only** system; there is no public sign-up screen. Create the admin
account from the Supabase dashboard (**Authentication → Users → Add user**) or, for a
production setup, disable public sign-ups in **Authentication → Providers → Email**.

### 5. Set up the database

```bash
npm run prisma:generate     # generate the Prisma client
npm run prisma:migrate      # create the boutiques table (dev)
```

### 6. Run

```bash
npm run dev
```

Open http://localhost:3000 → you are redirected to `/login`. Sign in with the admin user
you created, and you land on the dashboard.

---

## Scripts

| Script                    | What it does             |
| ------------------------- | ------------------------ |
| `npm run dev`             | Start the dev server     |
| `npm run build`           | Production build         |
| `npm run start`           | Run the production build |
| `npm run lint`            | ESLint (`next lint`)     |
| `npm run typecheck`       | `tsc --noEmit`           |
| `npm run format`          | Prettier write           |
| `npm run prisma:generate` | Generate Prisma client   |
| `npm run prisma:migrate`  | Run dev migrations       |
| `npm run prisma:studio`   | Open Prisma Studio       |

---

## Docker

Build and run the production image (expects a populated `.env`):

```bash
docker build -t sauda-jasa-admin .
docker run --env-file .env -p 3000:3000 sauda-jasa-admin
```

Or bring up the app together with a local Postgres:

```bash
docker compose up --build
```

The image uses Next.js `output: "standalone"` for a small runtime footprint and runs as a
non-root user.

---

## What lives where (quick map)

- **Auth**: `src/features/auth`, `src/lib/supabase/*`, `src/server/auth.ts`, `src/middleware.ts`
- **Dashboard**: `src/app/(dashboard)/dashboard`, `src/features/dashboard`, `src/services/dashboard.service.ts`
- **Boutiques (full CRUD)**: `src/features/boutiques/*` (form, dialogs, row actions),
  `src/hooks/use-boutiques.ts` (TanStack Query queries + mutations),
  `src/services/boutique.service.ts`, and route handlers `src/app/api/boutiques` +
  `src/app/api/boutiques/[id]` (create / read / update / delete, all auth-protected).
- **Shell (sidebar + navbar)**: `src/components/layout/*`
- **Data model**: `prisma/schema.prisma`

### Boutiques CRUD

Admins can create, edit, and delete boutiques from **Boutiques**. Forms use React Hook
Form + Zod (validated again on the server), writes go through TanStack Query mutations that
invalidate the list, and feedback is shown with toasts. Deleting asks for confirmation. All
data is entered by the admin — nothing is seeded.
