#!/usr/bin/env bash
# Throwaway local PostgreSQL cluster for development and tests. Sandbox only.
# Listens on 127.0.0.1 with trust authentication; never use this for shared or real data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.local/pg"
PORT="${AORA_PG_PORT:-54329}"
BIN="$(pg_config --bindir 2>/dev/null || true)"
if [ ! -x "$BIN/initdb" ]; then
  BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
fi
[ -x "$BIN/initdb" ] || { echo "PostgreSQL server binaries not found (need initdb, pg_ctl)." >&2; exit 1; }

BOUNCER_PORT="${AORA_PGBOUNCER_PORT:-54330}"
BOUNCER_DIR="$ROOT/.local/pgbouncer"

# PgBouncer in transaction mode with ONE server connection per role and database,
# like Neon's pooler but stricter: every transaction shares a backend, so any
# session state the application leaves behind shows up in tests.
find_bouncer() {
  if command -v pgbouncer >/dev/null 2>&1; then command -v pgbouncer; return; fi
  if [ ! -x "$BOUNCER_DIR/root/usr/sbin/pgbouncer" ] && command -v apt-get >/dev/null 2>&1; then
    mkdir -p "$BOUNCER_DIR"
    (cd "$BOUNCER_DIR" && apt-get download pgbouncer >/dev/null 2>&1 && dpkg -x pgbouncer_*.deb root) || true
  fi
  [ -x "$BOUNCER_DIR/root/usr/sbin/pgbouncer" ] && echo "$BOUNCER_DIR/root/usr/sbin/pgbouncer"
}

start_bouncer() {
  local bin
  bin="$(find_bouncer || true)"
  if [ -z "$bin" ]; then
    echo "PgBouncer not found; pooled-connection tests will be skipped (install the pgbouncer package)." >&2
    return 0
  fi
  mkdir -p "$BOUNCER_DIR"
  if [ -f "$BOUNCER_DIR/pgbouncer.pid" ] && kill -0 "$(cat "$BOUNCER_DIR/pgbouncer.pid")" 2>/dev/null; then return 0; fi
  printf '"aora_owner" ""\n"aora_app" ""\n"aora_platform" ""\n"postgres" ""\n' > "$BOUNCER_DIR/userlist.txt"
  cat > "$BOUNCER_DIR/pgbouncer.ini" <<INI
[databases]
* = host=127.0.0.1 port=$PORT
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = $BOUNCER_PORT
unix_socket_dir =
auth_type = trust
auth_file = $BOUNCER_DIR/userlist.txt
pool_mode = transaction
default_pool_size = 1
max_client_conn = 500
server_reset_query =
logfile = $BOUNCER_DIR/pgbouncer.log
pidfile = $BOUNCER_DIR/pgbouncer.pid
INI
  "$bin" -d "$BOUNCER_DIR/pgbouncer.ini"
  echo "PgBouncer (transaction mode, pool of 1) on 127.0.0.1:$BOUNCER_PORT"
}

stop_bouncer() {
  if [ -f "$BOUNCER_DIR/pgbouncer.pid" ]; then kill "$(cat "$BOUNCER_DIR/pgbouncer.pid")" 2>/dev/null || true; fi
}

psql_super() { "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

case "${1:-}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      "$BIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null
    fi
    if ! "$BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
      "$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/server.log" -w \
        -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$DIR" start >/dev/null
    fi
    psql_super -d postgres -f "$ROOT/services/api/prisma/bootstrap.sql"
    for db in aora_dev aora_test; do
      psql_super -d postgres -tc "select 1 from pg_database where datname = '$db'" | grep -q 1 ||
        psql_super -d postgres -c "create database $db owner aora_owner"
    done
    echo "PostgreSQL ready on 127.0.0.1:$PORT (databases: aora_dev, aora_test)"
    start_bouncer
    ;;
  stop)
    stop_bouncer
    "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null && echo "stopped"
    ;;
  reset)
    stop_bouncer
    "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true
    rm -rf "$DIR"
    echo "removed $DIR"
    ;;
  *)
    echo "usage: $0 start|stop|reset" >&2
    exit 2
    ;;
esac
