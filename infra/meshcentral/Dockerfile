# Pin qilingan MeshCentral (submodule) — oflayn ishga tushishi uchun PostgreSQL drayveri oldindan o'rnatiladi.
FROM node:24-bookworm-slim
WORKDIR /opt/meshcentral
COPY infra/meshcentral/upstream/package.json infra/meshcentral/upstream/package-lock.json ./
# MeshCentral PostgreSQL uchun aynan pg@8.16.3 ni kutadi (meshcentral.js:4478) — aks holda ishga tushganda internetdan o'rnatadi.
RUN npm ci --omit=optional --no-audit --no-fund && npm install --no-save --no-audit --no-fund pg@8.16.3
COPY infra/meshcentral/upstream/ ./
COPY infra/meshcentral/config.template.json infra/meshcentral/render-config.mjs /opt/netschool/
RUN mkdir -p meshcentral-data meshcentral-files && chown -R node:node /opt/meshcentral
USER node
ENTRYPOINT ["sh", "-c", "node /opt/netschool/render-config.mjs && exec node meshcentral.js --datapath /opt/meshcentral/meshcentral-data"]
