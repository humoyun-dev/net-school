# NetSchool

Maktab sinflari uchun masofaviy qurilma boshqaruvi va dars boshqaruvi. Masofaviy qurilma boshqaruvi dvigateli sifatida [MeshCentral](https://github.com/Ylianst/MeshCentral) ishlatiladi.

Arxitektura: [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md)

## Tuzilma

| Yo'l | Mazmun |
|---|---|
| `packages/domain/` | Transportdan mustaqil tiplar va portlar (`DeviceManagementPort`) |
| `packages/contracts/` | Versiyalangan schema'lar (capability report) |
| `packages/meshcentral-adapter/` | MeshCentral bilan gaplashadigan yagona kod: `control.ashx` klienti, inventory, eventlar, sessiya principal'lari |
| `packages/session-gateway/` | Remote session gateway: bir martalik ticket, gateway cookie, filtrlangan HTTP/WebSocket reverse proxy, revoke (MeshCentral'ni bilmaydi) |
| `packages/test-support/` | Testlar uchun umumiy yordamchilar (self-signed sertifikat va b.) |
| `tests/contracts/` | Pin qilingan real MeshCentral'ga qarshi contract testlar |
| `infra/meshcentral/` | MeshCentral pin (`upstream.lock.json`) va `upstream/` submodule |
| `docs/architecture/` | Arxitektura hujjatlari |
| `docs/adr/` | Qarorlar va sabablar |
| `docs/superpowers/plans/` | Yo'l xaritasi va sub-plan rejalari |

Qolgan yo'llar (`apps/`, `native/`...) arxitektura hujjati §12 bo'yicha kerak bo'lganda qo'shiladi.

## Klon qilish

```bash
git clone --recurse-submodules git@github.com:humoyun-dev/net-school.git
# yoki klondan keyin:
git submodule update --init
```

`infra/meshcentral/upstream` MeshCentral'ning aniq commit'iga pin qilingan, uni to'g'ridan-to'g'ri tahrirlamang. Yangilash tartibi: [infra/meshcentral/README.md](infra/meshcentral/README.md).

## Ishlab chiqish

Node 24+ va pnpm 11 kerak.

```bash
pnpm install
pnpm meshcentral:install   # submodule'dagi MeshCentral bog'liqliklari (contract testlar uchun)
pnpm test                  # unit testlar
pnpm test:contract         # vaqtinchalik real MeshCentral ishga tushirib, adapterni tekshiradi (~2 daqiqa)
pnpm typecheck && pnpm lint
```
