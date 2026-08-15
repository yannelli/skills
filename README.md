# Skills Tracker

A small full-stack app for logging the skills you are learning and how confident
you feel about each one. Built with **Next.js (App Router)**, **TypeScript**,
**Prisma**, and **SQLite**.

## Features

- Add a skill with a category, a 1–5 confidence rating, and optional notes.
- See all skills sorted by confidence, with an inline rating meter.
- Remove skills you no longer want to track.
- Data persists in a local SQLite database via Prisma.

## Tech stack

| Layer     | Choice                          |
| --------- | ------------------------------- |
| Framework | Next.js 15 (App Router)         |
| Language  | TypeScript                      |
| Data      | Prisma ORM + SQLite             |
| API       | Next.js Route Handlers          |
| Styling   | Hand-written CSS (no framework) |

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file and database
cp .env.example .env
npx prisma migrate deploy
npx prisma generate

# 3. (Optional) seed sample data
npm run db:seed

# 4. Start the dev server
npm run dev
```

Then open http://localhost:3000.

## Useful scripts

| Command              | What it does                                  |
| -------------------- | --------------------------------------------- |
| `npm run dev`        | Start the Next.js dev server on port 3000     |
| `npm run build`      | Production build                              |
| `npm run lint`       | Lint with `eslint-config-next`                |
| `npm run typecheck`  | Type-check with `tsc --noEmit`                |
| `npm run db:migrate` | Apply committed Prisma migrations             |
| `npm run db:seed`    | Insert a few sample skills                    |

## API

| Method   | Path               | Description        |
| -------- | ------------------ | ------------------ |
| `GET`    | `/api/skills`      | List all skills    |
| `POST`   | `/api/skills`      | Create a skill     |
| `DELETE` | `/api/skills/:id`  | Delete a skill     |

Example:

```bash
curl -s -X POST http://localhost:3000/api/skills \
  -H 'Content-Type: application/json' \
  -d '{"name":"Rust","category":"Languages","proficiency":2,"notes":"Learning ownership"}'
```

## Cloud Agent environment

`.cursor/environment.json` configures the Cursor Cloud Agent environment:
`install` restores dependencies, creates `.env`, applies migrations, and
generates the Prisma client; the `dev` terminal runs the app on port 3000.
