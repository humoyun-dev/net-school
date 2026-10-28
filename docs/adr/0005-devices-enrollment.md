# ADR 0005: Qurilmalar va enrollment

Sana: 2026-10-28 · Holat: qabul qilingan · Kontekst: P1b · Reja: [p1b-devices-enrollment](../superpowers/plans/2026-10-28-p1b-devices-enrollment.md)

## Maqsad

Maktab qurilmasini (Companion) hub'ga ishonchli ro'yxatdan o'tkazish, uning tirikligini va imkoniyatlarini ko'rsatish, MeshAgent node'iga admin tasdig'i bilan bog'lash (spec §6, §7, §8, §9).

## Qarorlar

- **Enrollment token.** `nse_` + 32 tasodifiy bayt (base64url), DB'da faqat SHA-256, bir martalik, TTL 5…1440 daqiqa (default 60). Token faqat yaratish javobida bir marta ko'rinadi; ro'yxat va auditda yo'q. Yaratish: school_admin (o'z site'i yoki butun tashkilot) va it_support (o'z site'i). Token site'ga va ixtiyoriy xonaga bog'lanadi; qurilma site'ni o'zi tanlay olmaydi.
- **Qurilma kaliti va claim.** Companion Ed25519 kalitni o'zida yaratadi; `POST /api/v1/enrollments/claim` SPKI DER (kanonik kodlash talab qilinadi) va `proof` = imzo(`NSCLAIM1\n<token>\n<publicKey>`) bilan. Proof tokenni sarflashdan **oldin** tekshiriladi, kalit fingerprint'i hub bo'yicha unique; xato proof yoki takroriy kalit tokenni yoqmaydi. Tokenni sarflash bitta atomik `UPDATE … WHERE claimed_at IS NULL AND revoked_at IS NULL AND expires_at > now`: parallel claim'lardan faqat bittasi o'tadi. Muvaffaqiyatsiz claim `device.claim failed` (`invalid_token` | `invalid_proof`) sifatida audit qilinadi; token noma'lum bo'lsa `organization_id` null (shu uchun audit check kengaytirildi). IP bo'yicha 30 urinish/daqiqa.
- **Imzolangan qurilma so'rovlari (mTLS emas).** Heartbeat va capability hisoboti cookie'siz: `x-ns-device-id`, `x-ns-timestamp` (ms), `x-ns-signature` = Ed25519(`NSDEV1\n<METHOD>\n<path+query>\n<ts>\n<sha256(raw body)>`). Qabul: `|now − ts| ≤ 30 s`, `ts > last_signed_ts` (atomik `UPDATE`, imzo tekshirilgandan keyin) — replay va parallel replay rad. JSON parser o'qimagan body bilan kelgan so'rov rad (imzosiz baytlar o'tmasligi uchun). Har xato bir xil 401. Sabab: hub'da client sertifikat CA'si, uning chiqarish/bekor qilish oqimi va TLS terminatsiyasi (keyin gateway oldida) murakkabroq; kalit egaligi bir xil darajada isbotlanadi. `@DeviceRoute()` marshrutlarida sessiya va `Origin` tekshiruvi yo'q (cookie ishlatilmaydi, CSRF qo'llanmaydi).
- **Presence.** Heartbeat har 10 s; `online` agar oxirgi heartbeat < 30 s oldin, aks holda `stale`, umuman bo'lmasa `never` (`packages/domain` `companionPresence`). `last_heartbeat_at` tarixiy qiymat; "online" faqat shu hisobdan.
- **Capability.** Claim'da va `PUT /api/v1/device/capabilities` bilan; qurilma hisoboti sifatida saqlanadi (eng ko'pi 64 kalit). Audit (`device.capabilities_changed`, o'zgargan kalitlar) faqat haqiqiy o'zgarishda; taqqoslash kalit tartibiga bog'liq emas (jsonb tartibni saqlamaydi).
- **Ruxsatlar.** `device.read` (site admin, it_support; teacher faqat biriktirilgan xonada), `device.enroll` (site admin, it_support), `device.manage` (xona biriktirish, retire, MeshAgent bog'lash — faqat school_admin), `site.configure_mesh` (faqat org-wide school_admin). Begona/noma'lum ID — P1a kabi bir xil 403 va audit.
- **Ma'lumotlar.** `devices`, `enrollments`, `mesh_bindings`, `device_capabilities`; qurilma va enrollment xonasi `(site_id, room_id) → rooms(site_id, id)` FK bilan faqat o'z site'idan. `mesh_bindings` unique `(mesh_instance_id, mesh_domain_id, mesh_node_id)`, bitta qurilma — bitta binding, binding site'i qurilma site'i bilan FK orqali bir xil. Retire: `retired_at`, binding o'chadi, imzolangan so'rovlar rad.
- **Admin tasdiqlaydigan MeshAgent bog'lash.** Hostname/IP bo'yicha avtomatik bog'lash yo'q (§6). Site → MeshCentral domain (`sites.mesh_domain_id`, sozlanganlari hub bo'yicha unique) faqat org admin tomonidan o'rnatiladi; shu sababli site admini boshqa site'ning node'ini ko'ra olmaydi va bog'lay olmaydi. Instance nomi config'dan (`MESH_INSTANCE_ID`, default `local`). `PUT /devices/{id}/mesh-binding` node'ni adapter `reconcileEnrollment` orqali tekshiradi (upstream'da hech narsa o'zgarmaydi); topilmasa 409 `conflict`, MeshCentral javob bermasa 503 `upstream_unavailable`, MeshCentral yoki site domain'i sozlanmagan bo'lsa 409 `capability_unavailable`.
- **MeshAgent holati.** Ro'yxat so'ralganda adapterdan (`listDevices`, 3 s timeout): `online`/`offline`; MeshCentral javob bermasa `unknown`, ro'yxat baribir 200. API MeshCentral'siz ham ishga tushadi va fonda ulanadi (`keepConnected`).
- **Yangi error kodlari:** `capability_unavailable` 409, `upstream_unavailable` 503.

## P0c bog'liqligi

P0c (OS PoC) hali bajarilmagan. P1b capability'ni faqat qurilma hisobotidan saqlaydi; server hech bir OS'ni "certified" deb belgilamaydi va capability'dan ruxsat chiqarmaydi. Agent o'rnatish manifesti va oflayn agent cache P0c'da.

## P1b'da yo'q (ongli ravishda)

- Qurilma WS kanali, buyruqlar va `GET /api/v1/events` — P1c.
- MeshAgent online eventlari (`subscribeDeviceEvents`) bilan doimiy holat — P1c events; hozircha so'rov paytida.
- Compose'da MeshCentral service account va `MESHCENTRAL_*` env — P1d (gateway bilan birga). Shu paytgacha deploy qilingan hub'da binding endpointlari 409 `capability_unavailable`.
- Qurilmani boshqa site'ga ko'chirish va nomini o'zgartirish; enrollment'ni ommaviy yaratish.
- Companion klienti — P1e.

## Ma'lum cheklovlar

- Claim IP limiti xotirada (bitta API jarayoni).
- Kalit yo'qolsa qurilma retire qilinib, yangi token bilan qayta ro'yxatdan o'tadi (kalit almashtirish oqimi yo'q).
- `MESH_INSTANCE_ID` o'zgartirilsa mavjud binding'lar boshqa instance'ga tegishli bo'lib qoladi.

## Dalillar

`apps/api/test/`: `enrollments.test.ts` (parallel claim, muddat, revoke, proof, kalit takrori, IP limiti), `device-auth.test.ts` (replay, ±30 s, begona kalit, o'zgartirilgan body, retired), `device-presence.test.ts`, `devices.test.ts` (teacher ko'rinishi, site chegarasi), `mesh-binding.test.ts` (parallel bog'lash, uzilish), `mesh-connect.test.ts`, `db-invariants.test.ts`; `packages/domain/test/{authorize,presence}.test.ts`; `tests/contracts/adapter.test.ts` (`reconcileEnrollment` real MeshCentral'da).
