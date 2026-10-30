# Pin qilingan MeshCentral (submodule) — oflayn ishga tushishi uchun PostgreSQL drayveri oldindan o'rnatiladi.
FROM node:24-bookworm-slim
WORKDIR /opt/meshcentral
COPY infra/meshcentral/upstream/package.json infra/meshcentral/upstream/package-lock.json ./
# MeshCentral PostgreSQL uchun aynan pg@8.16.3 ni kutadi (meshcentral.js:4478) — aks holda ishga tushganda internetdan o'rnatadi.
RUN npm ci --omit=optional --no-audit --no-fund && npm install --no-save --no-audit --no-fund pg@8.16.3
COPY infra/meshcentral/upstream/ ./
COPY infra/meshcentral/config.template.json infra/meshcentral/render-config.mjs /opt/netschool/
COPY --chmod=0755 infra/meshcentral/entrypoint.sh /opt/netschool/
# /run/meshcentral-ca — api bilan bo'lishiladigan volume (faqat root-cert-public.crt); egasi node bo'lishi kerak.
RUN mkdir -p meshcentral-data meshcentral-files /run/meshcentral-ca \
  && chown -R node:node /opt/meshcentral /run/meshcentral-ca
USER node
ENTRYPOINT ["/opt/netschool/entrypoint.sh"]
