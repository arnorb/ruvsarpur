# /docker/frontend.Dockerfile
FROM node:20-alpine AS build

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend ./

# Purpose: keep API calls same-origin behind nginx reverse proxy.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginx:1.27-alpine

# Purpose: allow runtime API target overrides in environments where service DNS differs.
ENV API_UPSTREAM=ruvsarpur-api:8000
# Effect: used when API_UPSTREAM is a hostname and must be resolved at request time.
ENV NGINX_RESOLVER=127.0.0.11

COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80
