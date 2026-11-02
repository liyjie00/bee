# Contributing to Bee

Thanks for helping. Bug reports, fixes and features are all welcome.

## Contributor License Agreement (required)

Bee is offered under AGPL-3.0 and, on request, under commercial licenses. To
keep that possible, every contribution must be covered by the
[Contributor License Agreement](CLA.md). The CLA lets the maintainer license
your contribution under other terms as well; you keep the copyright, and your
contribution stays available under AGPL-3.0.

To agree, include this line in the description of your pull request:

> I have read the Bee CLA (CLA.md) and agree to its terms for this and my future contributions.

A pull request cannot be merged until its author has agreed. If you contribute
on behalf of an employer, make sure you are allowed to grant the CLA for that
work, or have your employer contact contactus@bee.zippyzoo.dev.

## Reporting bugs and security issues

Open an issue with steps to reproduce, what you expected and what happened.
Please report security vulnerabilities privately to contactus@bee.zippyzoo.dev
instead of in a public issue.

## Development setup

See [Development](README.md#development) in the README. In short:

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

## Pull requests

- Keep each pull request to one change, and describe what it does and why.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` before opening it, and add
  tests for behavior you change in `apps/api` or `packages/*`.
- Database changes: edit `packages/db/src/schema.ts`, then run `pnpm db:generate`
  and commit the generated migration. Do not edit migrations that are already on `main`.
- Match the style of the code around your change; `pnpm format` runs Prettier.
- Commit messages follow `type(scope): summary`, e.g. `fix(web): …`, `feat(api): …`.
- Never commit secrets or a real `.env`. New settings go in `.env.example` with a
  comment, in `docker-compose.yml`, and in the README's configuration table.
