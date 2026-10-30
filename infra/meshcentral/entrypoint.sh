#!/bin/sh
# MeshCentral konteyneri: config → NetSchool service account → public CA'ni api bilan bo'lishish → server.
# Parol hech qayerga chiqarilmaydi (set -x yo'q, CLI chiqishi /dev/null yoki grep'ga).
set -eu

DATA=/opt/meshcentral/meshcentral-data
CA_DIR=/run/meshcentral-ca
SVC_USER=netschool-svc

node /opt/netschool/render-config.mjs

mc() { node meshcentral.js --datapath "$DATA" "$@"; }

# CLI buyruqlari faqat server to'xtagan holatda ishlaydi va xatoda ham exit 0 qaytaradi — natija DB'dan qayta o'qiladi.
# --createaccount mavjud user'da "User already exists." deydi va parolni o'zgartirmaydi (meshcentral.js:1043).
account() { mc --showitem "user//$SVC_USER"; }
case "$(account)" in
  *"\"_id\": \"user//$SVC_USER\""*) ;;
  *)
    pass=$(cat "$MESHCENTRAL_SERVICE_PASSWORD_FILE")
    [ -n "$pass" ] || { echo "netschool: MESHCENTRAL_SERVICE_PASSWORD_FILE is empty" >&2; exit 1; }
    # `--pass=` shakli: minimist `--pass -…` ni flag deb o'qimasin.
    mc --createaccount "$SVC_USER" --pass="$pass" --email "$SVC_USER@netschool.invalid" >/dev/null
    unset pass
    echo "netschool: created MeshCentral service account $SVC_USER"
    ;;
esac
# Yarim qolgan birinchi ishga tushish (account bor, admin emas) ham shu yerda tiklanadi.
case "$(account)" in
  *'"siteadmin": 4294967295'*) ;;
  *) mc --adminaccount "$SVC_USER" >/dev/null ;;
esac
case "$(account)" in
  *'"siteadmin": 4294967295'*) ;;
  *) echo "netschool: MeshCentral service account $SVC_USER is missing or not a site administrator" >&2; exit 1 ;;
esac

# Root CA serverning birinchi ishga tushishida yaratiladi; api'ga faqat public sertifikat beriladi (private key'lar
# meshcentral-data'da qoladi). Atomik almashtirish: api yarim yozilgan faylni o'qimaydi.
(
  waited=0
  until [ -s "$DATA/root-cert-public.crt" ]; do
    if [ "$waited" -ge 120 ]; then
      echo "netschool: root-cert-public.crt did not appear within 120 s" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  cp "$DATA/root-cert-public.crt" "$CA_DIR/.root-cert-public.crt.tmp"
  mv -f "$CA_DIR/.root-cert-public.crt.tmp" "$CA_DIR/root-cert-public.crt"
) &

exec node meshcentral.js --datapath "$DATA"
