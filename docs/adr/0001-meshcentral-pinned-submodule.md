# ADR 0001: MeshCentral pin qilingan submodule sifatida

Sana: 2026-10-27 · Holat: qabul qilingan

## Qaror
`net-school` NetSchool monorepo'si. MeshCentral `infra/meshcentral/upstream` da git submodule, `adce1ec488dc884ce947ea4e4808e6a520609b17` commit'iga pin qilingan.

## Sabab
Arxitektura hujjati §5.3 va §12: biznes kodi upstream fayllari bilan aralashmasligi va upstream yangilanishlari biznes kodidan ajratilgan holda qolishi kerak. Avval upstream tarixi `main` ga to'g'ridan-to'g'ri birlashtirilgan edi (push qilinmagan), bu tuzilmaga zid bo'lgani uchun bekor qilindi.

## Oqibatlar
- Klonda `--recurse-submodules` kerak.
- Upstream o'zgarishi faqat lock fayl va submodule pointer orqali, ko'rib chiqilgan holda kiradi.
- Zarur patchlar alohida `meshcentral-fork` da.
