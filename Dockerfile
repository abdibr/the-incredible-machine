# The headless turn service (ticket #45 service, ticket #47 image): a lean,
# browser-free Node runtime image.
#
# Build context = production whitelist only, enforced twice (see
# .dockerignore): game modules js/ (incl. js/levels/puzzles/*.json level data
# read via node:fs), the agent layer agent/, and the package manifests.
# tests/, docs/, scripts/, resources/, css/, index.html and every *.md are
# ABSENT from the image (dependency metadata *.md is stripped below too) -
# verified by scripts/docker-demo.mjs (docker run --rm --entrypoint node +
# recursive fs audit).
#
# Build -> run -> win (full host-side sequence, with curl call examples):
#   scripts/docker-demo.mjs
# LLM end-to-end - the host-side driver plays level-01 against THIS image,
# from a clean state, host<->container switch = env config only (ticket #49):
#   scripts/e2e-demo.mjs
#
# Manual quick-start:
#   docker build -t tim-turn-service .
#   docker run -d --rm --name tim-turn-demo -p 8787:8787 tim-turn-service
#   curl -X POST http://127.0.0.1:8787/turn -H "Content-Type: application/json" \
#        -d '{"action":"place","type":"ball","x":700,"y":500}'
#   curl -X POST http://127.0.0.1:8787/turn -H "Content-Type: application/json" \
#        -d '{"action":"trial","seconds":5}'     # outcome = "reached"
#   docker rm -f tim-turn-demo
#
# No browser/Chromium/graphics dependencies: FROM node:<lts>-alpine, zero
# installed system packages, no apk/apt, npm runtime dep = matter-js only.
# The service itself (agent/server.js) uses node:http alone. Node tracks the
# repo toolchain (vite 7 / vitest 4 support: node >= 22.12; host runs node 24).

FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

# Manifests first: dependencies resolve from the lockfile into their own
# cacheable layer, independent of source edits. devDependencies (vite,
# vitest) are NOT installed - the image has no build/test tooling - and
# dependency metadata *.md (e.g. matter-js README/CHANGELOG) is stripped so
# the finished image carries zero *.md files anywhere.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && find /app/node_modules -name '*.md' -delete \
    && npm cache clean --force

# Production code only (the context whitelist in .dockerignore repeats this).
COPY js ./js
COPY agent ./agent

# Unprivileged runtime user from the base image.
USER node

# Port configurable via env (ticket AC); listens on all interfaces inside the
# container namespace so a published port (-p) reaches it. Defaults here are
# the documented ones; docker run may override with -e.
ENV TIM_TURN_PORT=8787 \
    TIM_TURN_HOST=0.0.0.0
EXPOSE 8787

# exec -> node stays PID 1 and keeps signal handling. TIM_AGENT_SEED (ticket
# #46) passes through untouched when provided at run time.
ENTRYPOINT ["sh", "-c", "exec node agent/server.js --host \"${TIM_TURN_HOST:-0.0.0.0}\" --port \"${TIM_TURN_PORT:-8787}\""]
