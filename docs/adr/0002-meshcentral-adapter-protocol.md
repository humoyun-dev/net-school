# ADR 0002: MeshCentral adapter protokoli

Sana: 2026-10-27 · Holat: qabul qilingan · Kontekst: P0a

## Qarorlar

- **Ulanish.** Bitta persistent WebSocket: `wss://<host>/control.ashx`. Auth `x-meshauth: base64(user),base64(pass)` header bilan. TLS faqat berilgan `ca` va hostname (`servername`) bilan tekshiriladi; `rejectUnauthorized: false` ishlatilmaydi.
- **Tayyorlik.** Server birinchi bo'lib `{action:'serverinfo'}` yuboradi; `connect()` shu xabarda tugaydi.
- **Correlation.** Har so'rovga `responseid = randomUUID()`. Javobda `result` yo'q yoki `'ok'` → muvaffaqiyat; boshqa `result` → `upstream_rejected` (`detail` = upstream matni). Default timeout 10 s.
  - `meshes` javobi `responseid` qaytarmaydi; adapter unga tayanmaydi (`createmesh` javobida `meshid` bor).
- **Auth xatosi.** Server `{action:'close', cause:'noauth'}` yuborib ulanishni yopadi → `upstream_auth_failed`. Ketma-ket xato loginlarda MeshCentral **IP diapazonini bloklaydi** (default 10 urinish / 10 daqiqa, `webserver.js`), bu shu IP'dagi barcha userlarga, jumladan adapter admin'iga ta'sir qiladi.
- **Tayyorlik timeout va heartbeat.** Handshake + `serverinfo` 15 s ichida kelmasa ulanish yopiladi (`upstream_timeout`), reconnect yo'lida esa qayta urinish davom etadi. Har 30 s ping; keyingi ping'gacha pong bo'lmasa ulanish o'lik deb uziladi va reconnect + resync bo'ladi.
- **Mustahkamlik.** Obyekt bo'lmagan kadrlar (`null`, son, massiv, JSON emas) e'tiborsiz qoldiriladi; subscriber xatosi transportni yiqitmaydi (`process.emitWarning`).
- **Reconnect.** Faqat bir marta muvaffaqiyatli ulangandan keyin: exponential backoff + full jitter (1–30 s). Pending so'rovlar darhol `upstream_unavailable` bilan rad etiladi. Qayta ulangach `resync` event → iste'molchi snapshot'ni qayta oladi. Reconnect paytidagi auth/TLS xatosi fatal (qayta urinilmaydi).
- **Xabar hajmi.** `maxMessageBytes` (default 4 MiB) dan katta kadr ulanishni uzadi va reconnect qiladi.
- **Rights.** Sessiya principal'i: control = `0xC00E08` (REMOTECONTROL | NOTERMINAL | NOFILES | NOAMT | NOREGISTRY | NOSOFTWARE), view = `0xC00F08` (+ REMOTEVIEWONLY). `EDITMESH|MANAGEUSERS|MANAGECOMPUTERS` (1|2|4), AGENTCONSOLE (16), REMOTECOMMAND (0x20000) hech qachon berilmaydi; upstream `adddeviceuser` 1|2|4 ni o'zi ham rad etadi.
- **Principal per sessiya.** `adduser {username: 'ns-sess-<uuid>', pass, siteadmin: 0x1440}` (NONEWGROUPS | LOCKSETTINGS | NONEWDEVICES; `siteadmin: 0` guruh yaratishga ruxsat berardi) → `adddeviceuser {userids, nodeid, rights}`; grant xatosida `deleteuser` bilan kompensatsiya. `randomPassword: true` **yuborilmaydi**: server unda parolni o'zinikiga almashtiradi. Revoke = `deleteuser`; `'User does not exists'` muvaffaqiyat deb olinadi.
- **Mapping.** Offline qurilmada `conn`/`pwr`/`osdesc` kelmaydi → `agentOnline=false`, `powerState='unknown'`, `osDescription=null`. Eventlarda nodeid `event.nodeid` (removenode, nodeconnect) yoki `event.node._id` (addnode, changenode). Boshqa domain node'lari tashlab yuboriladi.

Contract testlar (`tests/contracts/adapter.test.ts`) yuqoridagilarni real pin qilingan MeshCentral'da isbotlaydi, jumladan: principal faqat grant qilingan qurilmani ko'radi, user yarata olmaydi, qurilma guruhi yarata olmaydi, revoke'dan keyin kira olmaydi.

## Ma'lum cheklovlar (release'dan oldin yopilishi shart)

- **View-only to'liq read-only emas.** Upstream `routeCommandToNode` REMOTEVIEWONLY bilan ham `msg` subbuyruqlarini (`pskill`, `serviceStop`, `openUrl`, `setclip` va boshq.) agentga uzatadi, agent esa rights tekshirmaydi (`meshuser.js:288`, `agents/meshcore.js`). Spec §5.2 talabi bajarilishi uchun principal credential brauzerga yetguncha gateway bu buyruqlarni bloklashi yoki kichik fork patch kerak (P0b qaror nuqtasi).
- **Server konfiguratsiyasi.** `domains.*.newAccountsUserGroups` va `newAccountsRights` bo'sh bo'lishi shart: aks holda yangi principal avtomatik guruhlarga qo'shilib, butun mesh'larga ruxsat oladi (`meshuser.js` serverCommandAddUser). Bu `infra/meshcentral` config shablonida qat'iy belgilanadi (P1a).

## P0b uchun ochiq savollar

1. `deleteuser` principal'ning **ochiq** desktop/relay WebSocket'larini uzadimi, yoki gateway ularni o'zi yopishi shartmi?
2. Iframe'dagi upstream desktop viewer'ga principal qanday kiritiladi: login token (`createLoginToken`) yoki gateway cookie orqali proksi'da `x-meshauth`? Token muddati ochiq sessiyani uzmaydi (spec §5.2).
3. Remote desktop relay'ni majburiy qilish (P2P/WebRTC o'chirish) qaysi sozlama bilan va qanday tekshiriladi?
4. IP ban: principal login xatolari hub IP'sidan kelganda adapter admin'i ham bloklanishi mumkin — hub IP'sini ban'dan chiqarish yoki principal login'larini boshqa yo'ldan o'tkazish.
5. `domain.passwordrequirements` yoqilgan serverda base64url principal paroli talabga mos keladimi.
