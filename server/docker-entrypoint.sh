#!/bin/sh
set -e

# Wait for PostgreSQL to be ready (postgresql-client is already in the image)
echo "Waiting for PostgreSQL..."
until pg_isready -h "${POSTGRES_HOST:-postgres}" -p "${POSTGRES_PORT:-5432}" -U "${POSTGRES_USER:-frog}" -d "${POSTGRES_DB:-analytics}" -q; do
  sleep 1
done
echo "PostgreSQL is ready."

# Run file-based migrations
# Appel direct du binaire, et non `npm run db:migrate` : npm est retire de
# l'image finale (ses dependances embarquees portaient une dizaine de CVE, dont
# tar CVE-2026-59873 en CRITICAL). La commande executee est identique a celle
# du script db:migrate de package.json.
echo "Running database migrations..."
./node_modules/.bin/drizzle-kit migrate --config=drizzle.config.ts

# Start the application
echo "Starting application..."
exec "$@"
