FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY dist ./dist

ENV NODE_ENV=production
ENV PORT=4000
# Non-loopback bind: SERVER_AUTH_TOKEN must be provided at runtime.
ENV HOST=0.0.0.0

CMD ["node", "dist/server.js"]
