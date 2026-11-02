# ADR 0010: Markaziy quvvat boshqaruvi

Sana: 2026-11-02 · Holat: qabul qilingan · Kontekst: P1h · Reja: [p1h-power-management](../superpowers/plans/2026-11-02-p1h-power-management.md)

## Maqsad

IT admin markazdan kompyuterlarni o'chiradi, qayta yuklaydi, uxlatadi va (WoL qo'llasa) yoqadi. Ko'lam: tanlangan qurilmalar, xonalar, binolar (site) yoki butun universitet. Amal darhol, belgilangan vaqtda yoki haftalik jadval bilan bajariladi. Har qurilma natijasi alohida ko'rinadi (spec §5.1, §7.1, §9, §15.1; [ADR 0007](0007-central-university-management.md)).

## Egasining qarorlari (2026-11-02)

- **Jadval:**
  - bir martalik (`runAt`, ko'pi bilan 30 kun oldinga);
  - takroriy: haftaning kunlari (1 = Du … 7 = Ya), `HH:MM`, IANA vaqt mintaqasi.
- **Rollar (`power.manage`):**
  - org-wide `school_admin` (markaziy IT admin) — hamma site va `organization` ko'lami;
  - site `school_admin` va site `it_support` — faqat o'z site'i;
  - teacher va student — yo'q.
- **UI.** IT admin sahifasi P1f'da. Bu bosqichda faqat API.

## Qarorlar

- **Alohida jadvallar** (migratsiya `0010`): `power_actions`, `power_action_targets`, `power_schedules`.
  - `commands`/`command_targets` darsga bog'langan: `lesson_id NOT NULL`, xona voqealari, xona advisory lock'i. Quvvat amali esa darssiz va ko'p xonali, shuning uchun alohida.
  - P1c naqshlari qayta ishlatiladi: target bo'yicha holat, `Idempotency-Key`, audit bitta tranzaksiyada, `FOR UPDATE SKIP LOCKED`.
  - Quvvat amallari xona `events` jurnaliga yozilmaydi (ADR 0008 lock tartibiga tegmaydi). UI `GET /power-actions/{id}`ni so'rab turadi.
- **API:**
  - `POST /api/v1/power-actions/preview` (son, unbound, agent online/offline yoki `null`);
  - `POST /api/v1/power-actions` (`Idempotency-Key`, 202);
  - `GET /api/v1/power-actions[?limit]`, `GET /api/v1/power-actions/{id}` (har target bilan);
  - `POST /api/v1/power-actions/{id}/cancel`;
  - `POST|GET /api/v1/power-schedules`, `PATCH|DELETE /api/v1/power-schedules/{id}`.
  - Ko'lam: `organization | sites | rooms | devices`. Noma'lum yoki begona id — audited 403. Ro'yxat faqat ko'lamning hamma site'iga ruxsatli amallarni ko'rsatadi.
- **Tasdiq.** Aniqlangan qurilmalar soni > 1 bo'lsa, `confirmDeviceCount` aynan shu songa teng bo'lishi shart. Aks holda 409 `confirmation_required` (yangi error kodi). 0 qurilmali amal — 409 `conflict`. Jadvalda bo'sh ko'lam ruxsat.
- **Targetlar** amal boshlanganda joriy ko'lamdan yaratiladi:
  - retired qurilma chiqariladi;
  - mesh binding'siz qurilma `failed: unbound`.
  Jadval va kechiktirilgan amal ishga tushgandagi holatni oladi. Tasdiq faqat yaratishda.
- **Ijrochi — MeshAgent, adapter orqali** (`requestPowerAction`). Har chaqiruv bitta node uchun: ko'p nodeid'li `poweraction` bitta `responseid` bilan bir nechta javob yuboradi.
  - `actiontype`: 2 — o'chirish, 3 — qayta yuklash, 4 — uxlatish. Yoqish — `wakedevices`.
  - Wake diagnostikasi (`No known MAC…`, `No network information…` → `wake_unsupported`; `Invalid nodeid|domain` → `node_missing`) haqiqiy `MeshControlClient`da `upstream_rejected` xatosining `detail`ida keladi. Buni contract testi topdi.
- **Bosqichma-bosqich.** Bitta to'lqinda 50 qurilma, to'lqinlar orasida 5 s (`POWER_WAVE_SIZE`, `POWER_WAVE_INTERVAL_MS`). To'lqin oldidan bitta `listDevices` olinadi:
  - o'chirish, qayta yuklash, uxlatish uchun agenti offline qurilma → `failed: device_offline`;
  - yoqish uchun allaqachon online qurilma → `succeeded` (so'rov yuborilmaydi).
- **Ko'pi bilan bir marta.** Target `sent` bo'lib commit qilinadi, keyin MeshCentral'ga yuboriladi.
  - Javob kelmasa yoki hub o'lsa, qayta yuborilmaydi: reboot ikki marta bo'lmaydi.
  - Aniq rad (`accepted: false`) → `failed: <sabab>`.
  - Ikki replika bir targetni yubormaydi (real PostgreSQL testi va lock'siz mutatsiya bilan tasdiqlangan).
  - Snapshot claim tranzaksiyasi ichida olinadi (bitta amal qatori lock'i, adapter timeout ≤ 3 s).
- **Natija kuzatuv bilan.** MeshCentral `poweraction`ga huquq tekshiruvidan oldin `ok` deydi, shuning uchun `ok` bajarildi degani emas. Har tick'da `sent` targetlar uchun `listDevices` olinadi (`judgePowerTarget`):
  - o'chirish: agent offline yoki `powerState = off`;
  - uxlatish: offline yoki `sleep`;
  - qayta yuklash: avval offline, keyin yana online;
  - yoqish: online.
  Muddat tugasa (o'chirish va uxlatish 180 s, qayta yuklash 600 s, yoqish 300 s) natija `unknown`. `pending`/`sent` targeti qolmagan amal `completed` bo'ladi, audit `power.completed` (summary, actor `null`).
- **Kech yuborilmaydi.** Darsda kutilmagan o'chirish yoki qayta yuklash bo'lmasligi uchun kechikish ikki joyda nazorat qilinadi:
  - To'lqin jadvali 10 daqiqadan ko'p eskirgan bo'lsa (`next_wave_at < now − 10 min`), amalning qolgan `pending` targetlari `failed: upstream_unavailable` bo'ladi. Sabab: hub o'chiq bo'lgan yoki MeshCentral uzilgan, ya'ni to'lqinlar yurmagan. Kechikish `run_at`dan emas, oxirgi to'lqindan hisoblanadi, shuning uchun 10 daqiqadan uzun katta amal to'xtamaydi.
  - Bitta site snapshot'i olinmasa (domain bog'lanmagan yoki MeshCentral javob bermadi), faqat o'sha site targetlari kechiktiriladi (`retry_at`, `deferred_since`; migratsiya `0011`). Boshqa site'lar davom etadi. `deferred_since`dan 10 daqiqa o'tsa → `failed: upstream_unavailable`.
- **Eskirgan `runAt`.** Grace'dan (10 daqiqa) eski `runAt` 400 `validation_failed` bilan rad etiladi: kechagi so'rovning qayta urinishi hozir bajarilmaydi.
- **Izolyatsiya va hajm:**
  - Har jadval va har boshlanayotgan amal o'z tranzaksiyasida ishlaydi, bittasining xatosi boshqalarini to'smaydi.
  - Targetlar 1000 tadan bo'lib insert qilinadi (PostgreSQL parametr limiti, minglab qurilmali universitet).
  - To'lqin `(site, device)` tartibida olinadi. Har site snapshot'i tick ichida bir marta olinadi (claim va kuzatuv umumiy). Site qatorlari tick boshida yuklanadi.
  - Rad etilgan wake faqat o'z amalining targetini o'zgartiradi.
- **Ro'yxat** ruxsat bo'yicha SQL'da filtrlanadi:
  - org admin hammasini ko'radi;
  - site admin va IT faqat ko'lamining hamma site'i o'ziniki bo'lgan amallarni ko'radi;
  - `organization` ko'lamidagi amallar faqat org admin'ga ko'rinadi.
  Shuning uchun bandroq tashkilotda ham site admin o'z amallarini ko'radi.
- **Kechikish (`missed`).** Vaqtidan 10 daqiqadan ko'p kechikkan amal yoki jadval vaqti bajarilmaydi: ertalab kechagi o'chirish bo'lmaydi.
  - Amal `missed`, audit `power.missed`, jadvalning keyingi vaqti hisoblanadi.
  - Bitta jadval vaqtiga bitta amal: unique `(schedule_id, run_at)`, `ON CONFLICT DO NOTHING`.
- **Vaqt mintaqasi.** `nextOccurrence` `Intl.DateTimeFormat` bilan hisoblaydi (Node 24'da `Temporal` yo'q). DST oralig'idagi mavjud bo'lmagan vaqt oldinga suriladi. Toshkentda DST yo'q.
- **Audit:**
  - foydalanuvchi amallari: `power.request`, `power.cancel`, `power.schedule_create|update|delete`;
  - tizim yozuvlari (actor `null`): `power.completed`, `power.missed`.
  - Ko'lam auditda ixcham (`kind`, soni, ≤20 id).

## Cheklovlar va keyingi ishlar

- **Service account huquqi.** MeshCentral service account'ida qurilma guruhiga `RESETOFF` (0x40000) yoki `WAKEDEVICE` (0x40) bo'lmasa, MeshCentral jimgina hech narsa qilmaydi va natija `unknown` bo'ladi. Compose service account site admin va o'zi yaratgan guruhlarda to'liq huquqli. Boshqa guruhlar uchun huquqlar tekshirilmagan.
- **Wake-on-LAN** BIOS/NIC qo'llasa, kompyuter tokda bo'lsa va o'sha tarmoq segmentida yoqiq agent bo'lsa ishlaydi. `Used 0 device(s)` ham qabul qilinadi, natijani kuzatuv hal qiladi.
- **Haqiqiy agent sinovi** (kompyuter haqiqatan o'chishi, qayta yonishi, WoL) — P0c. Contract testi faqat protokolni pin qiladi.
- **Agent offline'ligi o'chganini isbotlamaydi.** Tarmoq uzilishi ham `succeeded` ko'rinadi. `powerState` faqat MeshCentral bergan holat.
- Faqat default MeshCentral domain'i tekshirilgan (ADR 0008 bilan bir xil).
- Hub'ning in-process notifier'i ishlatilmaydi. Natijalar UI so'rovi bilan ko'rinadi (P1f).
- **Yakuniy review'dan keyin qoldirilgan mayda ishlar:**
  - node snapshot'da yo'q bo'lsa sabab `device_offline` (`node_missing` emas);
  - yakunlangan amalni bekor qilish 200 qaytaradi va audit yozadi; bekor qilingan running amal oxiri `completed`;
  - tasdiqlangan son tranzaksiyadan tashqarida tekshiriladi;
  - MeshCentral holati har replikada alohida;
  - `running` amalda `next_wave_at` va target/amal `organization_id` mosligi uchun DB check yo'q;
  - fall-back (takrorlanadigan soat) vaqti uchun test yo'q.
- Jadval yaratgan admin huquqini yo'qotsa ham jadval ishlayveradi. Ko'lamni ko'ra oladigan boshqa admin uni o'chiradi.

## Dalillar

- Domain: `packages/domain/test/power.test.ts` (natija qoidalari, muddatlar, `nextOccurrence`, DST), `authorize.test.ts` (`power.manage`).
- Contracts: `packages/contracts/test/power.test.ts`.
- Adapter: `packages/meshcentral-adapter/test/device-management.test.ts`; real MeshCentral — `tests/contracts/adapter.test.ts` (`requestPowerAction accepts shutdown…`, `waking a local device without network information is wake_unsupported`).
- API:
  - `apps/api/test/power-actions.test.ts` (ko'lam, rollar, tasdiq, idempotency, bekor qilish, ro'yxat);
  - `power-worker.test.ts` (to'lqinlar, kuzatuv, `unknown`, qayta ishga tushganda qayta yubormaslik, MeshCentral uzilishi, `missed`);
  - `power-schedules.test.ts`;
  - `db-invariants.test.ts`;
  - `concurrency.pg.test.ts` (`concurrent workers send each target once`).
