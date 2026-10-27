# ADR 0002: MeshCentral adapter protokoli

Sana: 2026-10-27 · Holat: qabul qilingan · Kontekst: P0a

## Qarorlar

- **Ulanish.** Bitta persistent WebSocket: `wss://<host>/control.ashx`. Auth `x-meshauth: base64(user),base64(pass)` header bilan. TLS faqat berilgan `ca` va hostname (`servername`) bilan tekshiriladi; `rejectUnauthorized: false` ishlatilmaydi.
- **Tayyorlik.** Server birinchi bo'lib `{action:'serverinfo'}` yuboradi; `connect()` shu xabarda tugaydi.
- **Correlation.** Har so'rovga `responseid = randomUUID()`. Javobda `result` yo'q yoki `'ok'` → muvaffaqiyat; boshqa `result` → `upstream_rejected` (`detail` = upstream matni). Default timeout 10 s.
  - `meshes` javobi `responseid` qaytarmaydi; adapter unga tayanmaydi (`createmesh` javobida `meshid` bor).
- **Auth xatosi.** Server `{action:'close', cause:'noauth'}` yuborib ulanishni yopadi → `upstream_auth_failed`. Ketma-ket xato loginlarda server javobni sekinlashtiradi.
- **Reconnect.** Faqat bir marta muvaffaqiyatli ulangandan keyin: exponential backoff + full jitter (1–30 s). Pending so'rovlar darhol `upstream_unavailable` bilan rad etiladi. Qayta ulangach `resync` event → iste'molchi snapshot'ni qayta oladi. Reconnect paytidagi auth/TLS xatosi fatal (qayta urinilmaydi).
- **Xabar hajmi.** `maxMessageBytes` (default 4 MiB) dan katta kadr ulanishni uzadi va reconnect qiladi.
- **Rights.** Sessiya principal'i: view = `3848` (REMOTECONTROL | REMOTEVIEWONLY | NOTERMINAL | NOFILES | NOAMT), control = `3592` (view-only bitisiz). `EDITMESH|MANAGEUSERS|MANAGECOMPUTERS` (1|2|4), AGENTCONSOLE (16), REMOTECOMMAND (0x20000) hech qachon berilmaydi; upstream `adddeviceuser` 1|2|4 ni o'zi ham rad etadi.
- **Principal per sessiya.** `adduser {username: 'ns-sess-<uuid>', pass, siteadmin: 0}` → `adddeviceuser {userids, nodeid, rights}`; grant xatosida `deleteuser` bilan kompensatsiya. `randomPassword: true` **yuborilmaydi**: server unda parolni o'zinikiga almashtiradi. Revoke = `deleteuser`; `'User does not exists'` muvaffaqiyat deb olinadi.
- **Mapping.** Offline qurilmada `conn`/`pwr`/`osdesc` kelmaydi → `agentOnline=false`, `powerState='unknown'`, `osDescription=null`. Eventlarda nodeid `event.nodeid` (removenode, nodeconnect) yoki `event.node._id` (addnode, changenode). Boshqa domain node'lari tashlab yuboriladi.

Contract testlar (`tests/contracts/adapter.test.ts`) yuqoridagilarni real pin qilingan MeshCentral'da isbotlaydi, jumladan: principal faqat grant qilingan qurilmani ko'radi, site huquqiga ega emas, revoke'dan keyin kira olmaydi.

## P0b uchun ochiq savollar

1. `deleteuser` principal'ning **ochiq** desktop/relay WebSocket'larini uzadimi, yoki gateway ularni o'zi yopishi shartmi?
2. Iframe'dagi upstream desktop viewer'ga principal qanday kiritiladi: login token (`createLoginToken`) yoki gateway cookie orqali proksi'da `x-meshauth`? Token muddati ochiq sessiyani uzmaydi (spec §5.2).
3. Remote desktop relay'ni majburiy qilish (P2P/WebRTC o'chirish) qaysi sozlama bilan va qanday tekshiriladi?
4. `connect()` uchun alohida timeout: server login'ni sekinlashtirganda chaqiruvchi cheksiz kutmasligi kerak.
5. `domain.passwordrequirements` yoqilgan serverda base64url principal paroli talabga mos keladimi.
