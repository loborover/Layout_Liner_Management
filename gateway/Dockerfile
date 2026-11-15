# Read-only data gateway for source data links (docs/DATA_SOURCES.md). Built from the repository root:
#   docker build -f gateway/Dockerfile -t layout-liner-data .
# Only the gateway's own files and its runtime packages go in; the database clients are installed here rather
# than in package.json so the editor's dependencies stay light.
FROM node:22-alpine
WORKDIR /app
RUN echo '{"name":"layout-liner-data","private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund tsx@4.23.15 pg@8.23.1 mysql2@3.24.6 mssql@12.7.14 \
 && npm cache clean --force
COPY gateway/drivers.ts gateway/datasets.ts gateway/server.ts ./gateway/
COPY gateway/example ./gateway/example
COPY src/data/records.ts ./src/data/records.ts
COPY src/model/types.ts ./src/model/types.ts
ENV NODE_ENV=production LL_DATA_CONFIG=/config/datasets.json LL_DATA_HOST=0.0.0.0 LL_DATA_PORT=7840 NODE_NO_WARNINGS=1
USER node
EXPOSE 7840
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:7840/health || exit 1
CMD ["node_modules/.bin/tsx", "gateway/server.ts"]
