# SPDX-FileCopyrightText: 2025 The Recoil Autohost Authors
#
# SPDX-License-Identifier: Apache-2.0

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig*.json ./
RUN npm ci

COPY src ./src
RUN npm run build:prod

# Keep runtime image small by pruning dev deps in build stage.
RUN npm prune --omit=dev


FROM node:22-bookworm AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        p7zip-full \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/dist ./dist
RUN mkdir -p config engines instances && chown -R node:node /app/

USER node

CMD ["node", "--enable-source-maps", "dist/main.js", "/app/config/config.json"]
