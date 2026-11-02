# One image (seatlock-app) for the API, the worker, the mock gateway and the migrate/seed job.
# docker-compose.yml picks the program with `command`.

# Build: bundle each entry point with esbuild. The @seatlock/* path aliases are inlined;
# npm packages stay external and are installed in the runtime stage.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY apps apps
COPY packages packages
RUN npm run build

# Runtime: plain Node running compiled JavaScript, production dependencies only.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY packages/db/migrations packages/db/migrations
COPY --from=build /app/dist dist
USER node
CMD ["node", "dist/api.js"]
