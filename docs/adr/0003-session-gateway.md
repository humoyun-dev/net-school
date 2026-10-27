# ADR 0003: Remote session gateway

Sana: 2026-10-28 · Holat: qabul qilingan · Kontekst: P0b · Reja: [p0b-session-gateway](../superpowers/plans/2026-10-27-p0b-session-gateway.md)

## Maqsad va chegara

Iframe'dagi upstream MeshCentral desktop viewer'iga brauzer **hech qanday MeshCentral credential'ini ko'rmasdan** ulanadi: principal paroli, `xid`/`xid.sig`, real `authCookie`/`authRelayCookie`, login token brauzerga yetmaydi. Pin: `adce1ec4` (ADR 0001). `infra/meshcentral/upstream` tahrirlanmadi.

Qatlamlar: `packages/session-gateway` (ticket, cookie, registry, HTTP/WS proksi; MeshCentral'ni bilmaydi) va `packages/meshcentral-adapter/src/desktop/` (yo'llar, kadrlar, credential almashtirish, upstream login; MeshCentral'ni faqat shu yer biladi).

## Qarorlar

- **Server tomonidagi login + cookie jar.** Gateway sessiya principal'i bilan `POST /login` qiladi (`upstream-login.ts`), `xid`/`xid.sig` jar'da (`cookie-jar.ts`) qoladi; upstream `Set-Cookie` brauzerga hech qachon uzatilmaydi. Sessiya bitta client IP'ga bog'lanadi (`cookieIpCheck: strict`; boshqa IP'dan `attach` rad). Login token ishlatilmaydi: u brauzerga upstream credential beradi va muddati ochiq sessiyani uzmaydi. `x-meshauth` HTML sahifada ishlamaydi, shuning uchun cookie jar kerak.
- **Ticket va gateway cookie.** Ticket 32 bayt, TTL 30 s, bir marta; serverda faqat SHA-256 hash, sarflash sinxron atomik (`tickets.ts`). Redeem `303` bilan `__Host-ns_rs` (`HttpOnly; Secure; SameSite=Strict; Path=/`, `Max-Age` yo'q) beradi; sessiya muddati serverda.
- **Credential handle'lar.** Sahifadagi `authCookie`/`authRelayCookie` va `control.ashx` `authcookie` javobidagi `cookie`/`rcookie` brauzerga opaque `nsh_…` handle bo'lib boradi (`credential-handles.ts`, har tur uchun oxirgi 2 juftlik: yangilanishda eski handle hali ishlashi kerak). Brauzer yuborgan handle gateway'da real qiymatga almashadi (`meshrelay.ashx?auth=`, tunnel `rauth`). Real qiymat sahifada/kadrda qolsa (JSON escape dan keyin ham) javob rad etiladi, sahifa esa 502 (fail closed). Sahifadagi uch qator (`authCookie`, `authRelayCookie`, `serverPublicNamePort`) aynan bir marta va bo'sh bo'lmagan qiymat bilan bo'lishi shart. Sabab: real `authCookie` `agentPort`dagi `meshrelay.ashx`da ham ishlaydi, ya'ni brauzerga chiqsa gateway chetlab o'tiladi (`gateway.test.ts` "direct relay bypass...": real cookie bilan relay ochiladi, handle bilan ochilmaydi).
- **Yo'l allowlist** (`routeViewerHttp`/`routeViewerWs`). HTTP: faqat `GET`/`HEAD`; `/` kirish sahifasi; `/scripts|styles|images|sounds/…` va `/favicon.ico`, `/manifest.json`, `/logo.png` (query yo'q yoki hex cache-buster); `..`, `//`, `\`, `%2e/%2f/%5c` rad. WS: `/control.ashx` (query'siz) va `/meshrelay.ashx` (kalitlar aynan `browser,p,nodeid,id,auth`, `nodeid` = sessiya node'i, `tcpport`/`udpport` yo'q). Boshqa hamma narsa 403.
- **Kirish URL'i (reja o'zgargan).** `gotonode` — **yalang'och node id** (`node//` prefiksisiz, `$`/`@` kodlanmagan): upstream sahifa `'node/'+domain+'/'+gotonode` qiladi va `%` bor qiymatni `parseUriArgs`da tashlaydi. Reja `encodeURIComponent('node//…')` degan edi; Chromium run'i (`viewer-browser.test.ts`) uning qurilmani tanlamasligini ko'rsatdi. Pastki qatlam URL'ni o'zi yasamaydi: faqat `session.upstream.entryPath` (redeem `Location`) ishlatiladi. Sahifa yuklangach URL'ni `/?hide=31` ga yozadi, shuning uchun **reload kirish yo'lida rad etiladi (fail closed)**: P1f iframe'i reload qilmay, qayta redeem qilishi kerak.
- **Sessiya bog'lanishi kirish yo'lida emas.** Upstream `parseUriArgs` URL fragment'ni ham o'qiydi (`common-0.0.1.js:120-122`), ya'ni `…#&gotonode=<boshqa>` sahifaga principal ko'ra oladigan boshqa node'ni tanlatishi mumkin. Shu sabab bog'lanish (a) `control.ashx`/relay kadr filtrlaridagi `nodeid === ctx.nodeId` tekshiruvlari va (b) principal'ning MeshCentral grant'i (faqat 1 node) bilan ta'minlanadi (`gateway.test.ts` "node swap attempts are denied", "scoped identity").
- **`control.ashx` yuqoriga (brauzer → server)** allowlist (`filterControlUp`), `responseid` ≤128 belgi:
  - `{action}`: `ping`, `pong`, `authcookie`, `usergroups`, `meshes`, `loginTokens`, `files`;
  - `{action, nodeid}` (`nodeid` = sessiya node'i): `powertimeline`, `lastconnect`, `getsysinfo`, `getnetworkinfo`, `deviceShares`; `{action:'getNotes', id}` (id = node);
  - `nodes`: kalitlar ⊆ `{action, responseid, id, skip, filter}`, `id` `''` yoki o'z node'i, `skip` butun ≥0, `filter` ≤256 belgi (haqiqiy viewer shuni yuboradi, `default.handlebars:2359`; natija baribir principal grant'i bilan cheklanadi);
  - `msg`: faqat `type:'tunnel'`, `usage:2`, `nodeid` = node, `value` = `*/meshrelay.ashx?` + aynan `p=2,nodeid,id,rauth` (handle → real); boshqa `msg` subbuyruqlari (`pskill`, `openUrl`, `setclip`, …), `tcpport`/`tcpaddr` tunnel'lar rad;
  - qolgan hamma action rad. Pastga (server → brauzer): `authcookie` handle'ga almashadi, credential oqishi rad.
- **Relay kadr filtri** (`filterRelayUp`, brauzer → agent): matn kadrlari — `'2'`, `{type:'options'}`, va faqat control rejimida lock/autolock (`ctrlChannel 102938`); qolgan matn (WebRTC signalizatsiyasi ham) rad. Binary: control rejimida o'tadi; view rejimida sarlavha uzunligi tekshiriladi va kiritish buyruqlari `{1,2,10,12,85,87}` tashlanadi. View rejimida `options` kadrdan `autolock` kaliti olib tashlanadi (aks holda view-only sessiya agentda autolock yoqardi, `meshcore.js:4491-4506`); kadr rad etilmaydi, chunki viewer uni startda yuboradi. `tsid` (bir qurilmadagi OS sessiyasini tanlash) hozircha o'tadi: P0c'da baholanadi.
- **HTTP proksi qattiqlashtirilgan** (`server.ts`). So'rov tanasi upstream'ga **hech qachon** yuborilmaydi (tana va `transfer-encoding` bo'lsa 400): review'da keep-alive ulanishda tana ikkinchi so'rov bo'lib `routeHttp`dan o'tib ketishi (request smuggling) topildi. Brauzer `cookie`, `authorization`, `x-meshauth`, `x-forwarded-*`, `forwarded`, … uzatilmaydi; `X-Forwarded-For`ni gateway brauzer socket IP'sidan o'zi qo'yadi. Upstream 30 s jim tursa 504. Kirish sahifasi content-type'dan qat'i nazar buferlanib qayta yoziladi, har javobga `x-content-type-options: nosniff`. Brauzerga ichki xato matni chiqmaydi.
- **WS proksi.** `Origin` aynan `publicOrigin` bo'lishi shart (cross-site WebSocket hijacking). Har kadr filtrdan o'tadi, filtr istisnosi = tashlash + yopish. Backpressure: `wsHighWaterMark` (8 MiB) dan oshsa manba pauza, yarmigacha tushsa davom; 4× chegarada juft 1008 bilan yopiladi. Upstream ochilguncha brauzer kadrlari 1 MiB gacha navbatda.
- **Revoke.** `deleteuser` `control.ashx` sessiyalarini yopadi (`viewer-upstream.test.ts` "revoke deletes the principal…"), lekin ochiq relay'larni yopmaydi (`meshrelay.js:175-180`) va haqiqiy relay soketlari close'ni ~30 s kech tasdiqlaydi. Shuning uchun gateway soketlarni o'zi `terminate()` qiladi (brauzerga close 1008) va upstream tasdig'ini kutmaydi. Contract test 2 s chegarasini `broker.close()` chaqiruvidan boshlab o'lchaydi (`gateway.test.ts` "revoke closes active control and relay sockets…"); keyin cookie 401, principal login `upstream_auth_failed`. Revoke xatosi yashirilmaydi, lekin brauzer soketlari baribir yopiladi.
- **Bitta brauzerda bitta viewer.** `__Host-ns_rs` cookie'si yangi redeem bilan almashadi va eski sessiya `superseded` sifatida yopiladi; so'rovlar jim holda boshqa sessiyaga yo'naltirilmaydi.
- **Server config shabloni** ([infra/meshcentral/config.template.json](../../infra/meshcentral/config.template.json), sabablar README'da): `trustedProxy: 127.0.0.1`, `desktopMultiplex:false`, `webRTC:false`, `allowLoginToken:false`, `allowFraming:false`, `cookieIpCheck:strict`, `maxInvalidLogin` (`blocking:'ip'`, `exclude: 127.0.0.1,::1`), `newAccounts:false`, `passwordRequirements` (min 16, har sinfdan 1). `settings.webRTC=false` faqat brauzerga feature bit beradi (`webserver.js:3555`), server o'zi WebRTC'ni majburlamaydi: haqiqiy to'siq gateway relay filtri.
- **Viewer ruxsat etilmagan narsalarsiz ishlaydi** (allowlist kengaytirilmadi): `/mstsc/*.js`, `/serverpic.ashx`, `/commander.ashx` va yuqoriga `events`, `userWebState` kadrlari rad etilgan, Chromium'da viewer baribir yuklanadi.

## Qaror nuqtasi (roadmap P0b)

Gateway qamray olmaydigan endpoint topildimi? **Yo'q.** Task 8–9 contract testlari (`gateway.test.ts`, `viewer-upstream.test.ts`, `viewer-browser.test.ts`) bypass, node almashtirish, tunnel, ticket replay va revoke'ni real pin qilingan MeshCentral'da isbotladi. **P0b uchun fork patch shart emas.**

Defence-in-depth uchun kelajakdagi `meshcentral-fork` nomzodlari (hozir gateway filtriga tayanamiz):
- user o'chirilganda / rights o'zgarganda relay sessiyalarini upstream yopishi;
- `tcpport`/`udpport` tunnel'larni RELAY huquqisiz rad etish;
- agent `msg` subbuyruqlarini rights bilan cheklash (hozir `meshuser.js` view-only'da ham uzatadi);
- WebRTC sozlamasini server tomonida majburlash.

## P0c'ga o'tkaziladiganlar (haqiqiy agent talab qiladi)

Runbook'da majburiy band:
- view-only'da klaviatura/sichqoncha haqiqatan qurilmaga yetmasligi (agent va gateway relay filtri birga); `msg` buyruqlari agentga yetmasligi (agentsiz node'da `routeCommandToNode` ularni e'tiborsiz qoldiradi, shuning uchun hozir faqat gateway unit testlari: tashlangan ⇒ uzatilmagan);
- WebRTC haqiqatan o'chiqligi;
- relay text-kadr allowlist'ining to'liqligi (real agent bilan barcha OS'larda);
- `tsid` (OS sessiyani tanlash) qabul qilinadimi;
- `agentPort`/`portBind` tarmoq ta'siri (real `authCookie` shu portda ham ishlaydi).

## Ma'lum cheklovlar

- Gateway restart'ida sessiyalar yo'qoladi, principal'lar yetim qoladi → P1d startup reconciliation; sessiya muddati/lease ham P1d.
- Bir brauzerda parallel ikki viewer yo'q (yuqoridagi `superseded`); P1f'da path-prefix yoki alohida origin bilan qayta ko'riladi.
- Brauzer soketlarida idle timeout/heartbeat yo'q; yopilgan sessiyalar xotiradan chiqarilmaydi.
- Reload kirish yo'lida rad etiladi (yuqorida).
- Harness'da bir martalik startup poygasi kuzatilgan: tayyor bo'lgandan so'ng darhol `MeshCentral rejected credentials` (6 runda takrorlanmadi); CI'da flake xavfi.
