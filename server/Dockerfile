# syntax=docker/dockerfile:1

# node:24-alpine et non node:20-alpine. Le npm LIVRE AVEC node:20 embarque
# tar 6.2.1 (CVE-2026-59873, CRITICAL), cross-spawn 7.0.3, glob 10.4.2,
# minimatch 9.0.5, sigstore 2.3.1 : une dizaine de failles qu'aucune
# modification de package.json ne peut atteindre, parce qu'elles ne sont pas
# dans les dependances du projet. Elles se corrigent par la base, ou en
# retirant npm de l'image finale -- ici on fait les deux.
FROM node:24-alpine AS builder

WORKDIR /app

# The runtime image ships Chromium itself. Avoid an unpinned browser download
# during dependency installation, which makes builds depend on Google storage.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Copy and build shared package first
COPY shared ./shared
WORKDIR /app/shared
RUN npm install && npm run build

# Install server dependencies
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --legacy-peer-deps

# Copy server source code
COPY server/ .

# Build the application (a besoin des devDependencies : tsc, esbuild)
RUN npm run build

# Les outils de construction n'ont rien a faire dans une image de production.
# C'est de la qu'entraient vitest (CVE-2026-47429, CRITICAL), vite, rollup,
# postcss et terser -- jamais executes en production, mais scannes et comptes
# comme surface d'attaque a chaque audit. drizzle-kit est passe en dependance
# de production dans package.json : les migrations tournent au demarrage.
RUN npm prune --omit=dev --legacy-peer-deps

# npm installs the file:../shared dependency as a relative symlink
# (node_modules/@rybbit/shared -> ../../../shared). The runtime stage re-homes
# node_modules from /app/server to /app, which leaves that link pointing at
# /shared — outside the image. Materialize it into a real directory so the
# copied node_modules is location-independent.
# APRES le prune : npm reecrit ce lien symbolique a chaque manipulation de
# l'arbre, donc materialiser avant le prune ne tiendrait pas.
RUN rm -rf node_modules/@rybbit/shared \
 && mkdir -p node_modules/@rybbit/shared \
 && cp -r /app/shared/package.json /app/shared/dist node_modules/@rybbit/shared/

# Runtime image
FROM node:24-alpine

WORKDIR /app

# apk upgrade : libcrypto3/libssl3 de la base accumulent leurs propres CVE
# entre deux publications de l'image node. Sans cette ligne, une image
# reconstruite aujourd'hui repart avec les failles OpenSSL d'il y a six semaines.
RUN apk --no-cache upgrade \
 && apk add --no-cache \
    postgresql-client \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# npm n'est pas utilise a l'execution : l'entrypoint appelle directement les
# binaires de node_modules/.bin. Le retirer supprime d'un coup toutes les
# failles de ses dependances embarquees, definitivement et quelle que soit la
# version de node choisie plus tard.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Configure Puppeteer to use system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copy built application and dependencies
COPY --from=builder /app/server/package*.json ./
COPY --from=builder /app/server/GeoLite2-City.mmdb ./GeoLite2-City.mmdb
COPY --from=builder /app/server/GeoLite2-ASN.mmdb ./GeoLite2-ASN.mmdb
COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/server/docker-entrypoint.sh /docker-entrypoint.sh
COPY --from=builder /app/server/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/server/drizzle ./drizzle
COPY --from=builder /app/server/public ./public
COPY --from=builder /app/server/src ./src

# Make the entrypoint executable
RUN chmod +x /docker-entrypoint.sh

# Expose the API port
EXPOSE 3001

# Use our custom entrypoint script
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/cluster.js"]
