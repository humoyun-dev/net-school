#!/bin/bash
# Birinchi ishga tushishda: NetSchool va MeshCentral uchun alohida database va user (spec §4).
# Userlar bir-birining database'iga ulana olmaydi.
set -euo pipefail

ns_pw="$(cat "$NETSCHOOL_DB_PASSWORD_FILE")"
mc_pw="$(cat "$MESHCENTRAL_DB_PASSWORD_FILE")"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v ns_pw="$ns_pw" -v mc_pw="$mc_pw" <<'EOSQL'
CREATE ROLE netschool LOGIN PASSWORD :'ns_pw';
CREATE ROLE meshcentral LOGIN PASSWORD :'mc_pw';
CREATE DATABASE netschool OWNER netschool;
CREATE DATABASE meshcentral OWNER meshcentral;
REVOKE CONNECT ON DATABASE netschool FROM PUBLIC;
REVOKE CONNECT ON DATABASE meshcentral FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE netschool TO netschool;
GRANT CONNECT ON DATABASE meshcentral TO meshcentral;
EOSQL
