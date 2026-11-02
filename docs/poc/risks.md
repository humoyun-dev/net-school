# P0c xavflari va cheklovlari

| # | Xavf | Ta'siri | Holat / chora |
|---|---|---|---|
| 1 | MeshCentral sertifikat nomida nuqta bo'lmasa LAN-only rejim (`meshcentral.js:1906`) | Agent `.msh`ga `MeshServer=local` yoziladi, hub'ga ulanmaydi | PoC overlay `meshcentral.hub.internal` ishlatadi. Agent sozlangan bo'lsa-yu nomda nuqta bo'lmasa `render-config` xato beradi. Production pilot ham nuqtali nom bilan bo'lishi shart |
| 2 | `MESH_AGENT_HOST` DHCP bilan o'zgaradi | O'rnatilgan agent eski manzilga ulanadi | Qat'iy IP yoki DNS nomi. O'zgarsa agentni qayta o'rnatish |
| 3 | Agent binary'lari GitHub release'laridan olinadi | GitHub ishlamasa image build bo'lmaydi | Pin (sha384) upstream commit'da, kesh lokal; CI keshlaydi. Runtime'da yuklab olish o'chiq |
| 4 | Windows Companion installer'siz (P2e) | Avtoishga tushirish yo'q, kalit fayli hamma user o'qiy oladigan joyda (ADR 0009) | PoC uchun qabul qilingan. P2d/P2e'da tuzatiladi |
| 5 | MeshCentral service account'ining qurilma guruhidagi huquqlari | Quvvat natijasi `unknown` (ADR 0010) | `mesh-agent-installer` guruhni service account bilan yaratadi, shuning uchun huquq to'liq. Boshqa guruhlar sinalmagan |
| 6 | Wake-on-LAN VM'da odatda ishlamaydi | `power.wake` tasdiqlanmaydi | Fizik kompyuterda va segmentda yoqiq agent bilan alohida sinash |
| 7 | UAC secure desktop | Control paytida UAC oynasi ko'rinmasligi mumkin | Qo'lda tekshiruv 10-band; natija matrix'da |
| 8 | Faqat Windows sinaladi | macOS, Linux X11 va Wayland bo'yicha da'vo yo'q | Matrix'da `not_tested`; release sharti (ADR 0007) bajarilmaguncha release yo'q |
| 9 | Hub ish Mac'ida | Mac uxlasa yoki tarmoq o'zgarsa sinov uziladi | Sinov vaqtida Mac uyquga ketmasin (`caffeinate`) |
