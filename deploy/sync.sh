#!/bin/zsh
# Deploy committed main to the Mac mini and (re)start the docker-compose stack
# on port 7070 there (Cloudflare Tunnel routes bee.zippyzoo.dev -> localhost:7070).
#   deploy/sync.sh                    run the test gate here, then deploy
#   deploy/sync.sh --skip-gate REASON deploy without running tests
# Environment: BEE_DEPLOY_HOST (ssh host, default mac-mini),
#              BEE_DEPLOY_DIR (remote checkout, default ~/Documents/bee).
# Data (Postgres volume, uploads) lives in docker volumes on the mini and is never synced.
set -euo pipefail

REPO="${0:A:h:h}"
HOST="${BEE_DEPLOY_HOST:-mac-mini}"
REMOTE="${BEE_DEPLOY_DIR:-Documents/bee}"
GATE=1
case "${1:-}" in
  --skip-gate) : "${2:?--skip-gate needs a reason}"; GATE=0 ;;
  "") ;;
  *) echo "usage: deploy/sync.sh [--skip-gate REASON]" >&2; exit 2 ;;
esac
SSH=(ssh -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-bee-%C" -o ControlPersist=60)
started=$SECONDS

BRANCH=$(git -C "$REPO" branch --show-current)
[[ "$BRANCH" == main ]] || { echo "refusing to deploy branch '$BRANCH': merge into main first" >&2; exit 1; }
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || {
  echo "refusing to deploy uncommitted changes" >&2; exit 1; }
SHA=$(git -C "$REPO" rev-parse --short HEAD)

# A commit that already passed the gate here is not re-tested (e.g. a retried deploy).
GATE_OK="$(git -C "$REPO" rev-parse --git-common-dir)/bee-gate-ok"
if (( GATE )) && grep -qx "$(git -C "$REPO" rev-parse HEAD)" "$GATE_OK" 2>/dev/null; then
  echo "== gate: $SHA already passed"; GATE=0
fi
if (( GATE )); then
  echo "== gate: typecheck + tests ($SHA)"
  # Typecheck and tests run side by side; both need the built workspace packages.
  (cd "$REPO" && corepack pnpm install --frozen-lockfile >/dev/null && corepack pnpm build >/dev/null \
    && { corepack pnpm -r --workspace-concurrency=2 run typecheck & tc=$!
         corepack pnpm -r run test; t=$?; wait $tc && (( t == 0 )); })
  git -C "$REPO" rev-parse HEAD >> "$GATE_OK"
fi

echo "== ship $SHA to $HOST:~/$REMOTE"
# Exactly the committed tree (git archive), extracted next to the live copy and
# swapped in; .env and the deploy log survive the swap.
git -C "$REPO" archive --format=tar HEAD | "${SSH[@]}" "$HOST" "set -e
  rm -rf $REMOTE.new && mkdir -p $REMOTE.new $REMOTE && tar -x -C $REMOTE.new
  for f in .env .deploys; do [ -f $REMOTE/\$f ] && cp $REMOTE/\$f $REMOTE.new/ || true; done
  rm -rf $REMOTE.old && mv $REMOTE $REMOTE.old && mv $REMOTE.new $REMOTE && rm -rf $REMOTE.old"

echo "== build and start on $HOST"
"${SSH[@]}" "$HOST" "REMOTE=$REMOTE SHA=$SHA zsh -l -s" <<'EOS'
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$HOME/$REMOTE"
if [[ ! -f .env ]]; then
  sed -e "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" \
      -e "s/^COLLAB_SECRET=.*/COLLAB_SECRET=$(openssl rand -hex 24)/" \
      -e "s|^BEE_PUBLIC_URL=.*|BEE_PUBLIC_URL=https://bee.zippyzoo.dev|" \
      -e "s|^DATABASE_URL=.*|DATABASE_URL=|" .env.example > .env
  echo "ALLOWED_ORIGINS=http://localhost:7070" >> .env
  POSTGRES_PASSWORD=$(openssl rand -hex 16)
  sed -i '' "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$POSTGRES_PASSWORD/" .env
  echo "created .env with fresh secrets"
fi
# Build from locally cached base images only: registry lookups from the mini's
# Docker VM can hang indefinitely. Refresh them by hand with `docker pull`.
docker compose build --pull=false
docker compose up -d --no-build --remove-orphans
# Compose does not recreate a container when only an inline config changed, so the
# proxy would keep serving its old Caddyfile. Recreating it takes a second.
docker compose up -d --no-build --force-recreate --no-deps proxy
for i in {1..60}; do
  if curl -fsS http://localhost:7070/api/health >/dev/null 2>&1; then
    echo "$SHA $(date '+%F %T')" >> .deploys
    echo "healthy: $SHA"; docker compose ps --format '{{.Name}} {{.Status}}'; exit 0
  fi
  sleep 2
done
echo "stack did not become healthy" >&2
docker compose ps; docker compose logs --tail 40 api collab proxy >&2
exit 1
EOS
echo "== deployed $SHA in $((SECONDS - started))s"
