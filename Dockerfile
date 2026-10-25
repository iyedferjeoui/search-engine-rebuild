FROM node:26-alpine
WORKDIR /app
COPY server.mjs test/ ./test/
COPY public/ ./public/
COPY data/ ./data/
ENV NODE_ENV=production
EXPOSE 8130
CMD ["node", "server.mjs"]