# syntax=docker/dockerfile:1
# The app as one long-lived Node server (Next.js standalone output), with the migrations it runs before starting.
# scripts/deploy.sh builds it for the Fargate task's platform; `docker compose up --build` builds it for the local machine.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Inlined into the client bundle at build time, so they're build arguments rather than runtime settings
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_DEMO=true
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_DEMO=$NEXT_PUBLIC_DEMO \
    NEXT_TELEMETRY_DISABLED=1 \
    BACKGROUND_JOBS=off
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# Amazon RDS's certificate authorities, so DB_SSL=true can verify the database (DB_SSL_CA)
ADD --chmod=444 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts/migrate.mjs ./scripts/migrate.mjs
# vendor/ holds Alpaca's OpenAPI specs, read only by tests; nothing else outside the bundle is read at runtime
USER node
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node server.js"]
