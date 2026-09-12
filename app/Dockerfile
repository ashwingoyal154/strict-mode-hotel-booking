# Portable path for any container host (Fly, Cloud Run, Railway, ECS).
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# tsx is a runtime dependency, so --omit=dev keeps it.
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src ./src
COPY tsconfig.json ./
ENV SM_DATA_DIR=/var/data
RUN mkdir -p /var/data
EXPOSE 8080
ENV PORT=8080
# SM_SECRET is intentionally NOT defaulted — the app refuses to boot without it.
CMD ["npm", "start"]
