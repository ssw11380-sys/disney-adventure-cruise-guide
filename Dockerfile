# 저장소 루트용 Dockerfile: Railway 등이 Root Directory 설정 없이 바로 백엔드를 빌드하도록 한다.
# 내용은 stock-briefing/backend/Dockerfile 과 같고 경로만 루트 기준이다.
FROM node:22-bookworm-slim AS build
# better-sqlite3 는 프리빌드 바이너리를 못 받으면 소스에서 컴파일하므로 빌드 도구를 넣어 둔다 (런타임 이미지에는 없음)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY stock-briefing/backend/package.json stock-briefing/backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY stock-briefing/backend/tsconfig.json ./
COPY stock-briefing/backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    TZ=Asia/Seoul \
    DATABASE_URL=/app/data/app.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY stock-briefing/backend/package.json ./
COPY stock-briefing/backend/prompts ./prompts
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
