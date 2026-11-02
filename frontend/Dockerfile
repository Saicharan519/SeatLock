# Build the React app, then serve the static files with nginx. nginx also proxies /api to
# the API container, so the browser talks to one origin, as with the Vite dev server.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
