FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY dist ./dist

ENV NODE_ENV=production
ENV PORT=4000

CMD ["node", "dist/server.js"]
