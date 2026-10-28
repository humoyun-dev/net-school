# NetSchool API image: build bosqichi esbuild bundle yaratadi, yakuniy image faqat prod dependency'lar bilan.
FROM node:24-bookworm-slim AS base
RUN npm install -g pnpm@11.0.9
WORKDIR /src
COPY . .

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter @netschool/api...

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @netschool/api... && pnpm --filter @netschool/api build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=deps /src/node_modules /app/node_modules
COPY --from=deps /src/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /src/apps/api/package.json ./package.json
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/api/drizzle ./drizzle
USER node
EXPOSE 8443
CMD ["node", "dist/main.mjs"]
