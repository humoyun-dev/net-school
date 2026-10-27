# NetSchool

Maktab sinflari uchun masofaviy qurilma boshqaruvi va dars boshqaruvi. Masofaviy qurilma boshqaruvi dvigateli sifatida [MeshCentral](https://github.com/Ylianst/MeshCentral) ishlatiladi.

Arxitektura: [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md)

## Tuzilma

| Yo'l | Mazmun |
|---|---|
| `infra/meshcentral/` | MeshCentral pin (`upstream.lock.json`) va `upstream/` submodule |
| `docs/architecture/` | Arxitektura hujjatlari |
| `docs/adr/` | Qarorlar va sabablar |

Qolgan yo'llar (`apps/`, `packages/`, `native/`...) arxitektura hujjati §12 bo'yicha kerak bo'lganda qo'shiladi.

## Klon qilish

```bash
git clone --recurse-submodules git@github.com:humoyun-dev/net-school.git
# yoki klondan keyin:
git submodule update --init
```

`infra/meshcentral/upstream` MeshCentral'ning aniq commit'iga pin qilingan, uni to'g'ridan-to'g'ri tahrirlamang. Yangilash tartibi: [infra/meshcentral/README.md](infra/meshcentral/README.md).
