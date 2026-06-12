FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
# tsx runs the TypeScript directly, so no build step; omit dev tooling (tsc, types).
RUN npm ci --omit=dev

COPY . .

# Drop privileges; the app only talks to Postgres and never writes to its own filesystem.
USER node

EXPOSE 8080

CMD ["npm", "run", "start"]
