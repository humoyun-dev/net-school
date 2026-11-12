# Capability matrix (P0c)

Har katakning holati:
- `not_tested` — sinovdan o'tmagan;
- `passed`, `partial` yoki `failed` — qavs ichida dalil bilan, masalan `passed (results/windows-x64-2026-11-03.json#remote)` yoki `partial (results/windows-x64-2026-11-03-manual.md)`.

`passed` dalilsiz qo'yilmaydi. CI har push'da `node scripts/poc/matrix.mjs` bilan tekshiradi (spec §7: hech bir OS sinovsiz "qo'llanadi" deb belgilanmaydi).

| Imkoniyat | Windows x64 | Windows ARM64 | macOS | Linux X11 | Linux Wayland |
|---|---|---|---|---|---|
| `enrollment` | passed (results/windows-x64-2026-11-02.json#device_enrolled) | not_tested | not_tested | not_tested | not_tested |
| `inventory` | passed (results/windows-x64-2026-11-02.json#agent_bound) | not_tested | not_tested | not_tested | not_tested |
| `remote.view` | passed (results/windows-x64-2026-11-03-manual.md) | not_tested | not_tested | not_tested | not_tested |
| `remote.control` | passed (results/windows-x64-2026-11-03-manual.md) | not_tested | not_tested | not_tested | not_tested |
| `remote.view_only_blocks_input` | passed (results/windows-x64-2026-11-03-manual.md) | not_tested | not_tested | not_tested | not_tested |
| `remote.revoke` | passed (results/windows-x64-2026-11-03-manual.md) | not_tested | not_tested | not_tested | not_tested |
| `power.shutdown` | passed (results/windows-x64-2026-11-03-shutdown.json#power_shutdown) | not_tested | not_tested | not_tested | not_tested |
| `power.reboot` | passed (results/windows-x64-2026-11-03-reboot.json#power_reboot) | not_tested | not_tested | not_tested | not_tested |
| `power.sleep` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `power.wake` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `classroom.message` | passed (results/windows-x64-2026-11-02.json#message) | not_tested | not_tested | not_tested | not_tested |
| `classroom.overlay` | partial (results/windows-x64-2026-11-09-hard-lock-manual.md) | not_tested | not_tested | not_tested | not_tested |
| `classroom.sas_block` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `classroom.overlay_lease_expiry` | passed (results/windows-x64-2026-11-03-manual.md) | not_tested | not_tested | not_tested | not_tested |
| `classroom.help` | passed (results/windows-x64-2026-11-03-manual.md) | not_tested | not_tested | not_tested | not_tested |
| `classroom.thumbnails` | passed (results/windows-x64-2026-11-02.json#thumbnail) | not_tested | not_tested | not_tested | not_tested |
| `web.filter` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `uac_secure_desktop` | passed (results/windows-x64-2026-11-03-manual.md) | not_tested | not_tested | not_tested | not_tested |
| `multi_monitor` | not_tested | not_tested | not_tested | not_tested | not_tested |

Hozircha sinov uchun faqat Windows mashinasi bor (egasi, 2026-11-02). macOS va Linux ustunlari mashina paydo bo'lguncha `not_tested` bo'lib qoladi.

Windows x64 (2026-11-02/03, Lenovo LOQ 15IRX9, Windows 11, hub Mac'da compose): `classroom.overlay` — `partial` (2026-11-09, kuchli bloklash sinovi, [ADR 0013](../adr/0013-windows-hard-lock-results.md)): hook Win, Ctrl+Esc, Alt+Tab, Alt+F4, Alt+Space, Ctrl+Shift+Esc'ni to'sadi; Ctrl+Alt+Del va Win+L to'silmaydi, siyosat SYSTEM huquqini talab qiladi (P2d). `power.sleep` sinalmagan; `power.wake` — noutbuk iste'molchi modeli, WoL sozlamasi topilmadi, hub'dan to'g'ridan-to'g'ri sehrli paket keyinga qoldirildi. `multi_monitor` — bitta monitor.

P2d1 (2026-11-11, [ADR 0014](../adr/0014-windows-helper.md)): SYSTEM helper qurildi; hub `classroom.overlay`ni helper holatidan hisoblaydi (`hard` faqat yangi helper hisoboti bilan: bloklashda hook, siyosat va process guard uchalasi active, bloklashsiz hech biri failed emas) va yangi `classroom.sas_block` capability'sini beradi (Pro/Home'da `unsupported`, `edition`). Qo'lda qabul sinovi hali o'tkazilmagan ([runbook](results/windows-x64-2026-11-11-helper-manual.md)), shuning uchun `classroom.overlay` P2d0 dalili bilan `partial` qoladi, `classroom.sas_block` — `not_tested`.

P2c (2026-11-12, [ADR 0015](../adr/0015-policy.md)): bazaviy va dars siyosati, Helper brauzer siyosatlari va Chrome/Edge extension'i qurildi; `web.filter` (`managed_extension`) Companion hisobotida. Extension do'konga chiqarilmagan va qo'lda qabul sinovi o'tkazilmagan ([runbook](results/windows-x64-2026-11-12-policy-manual.md)), shuning uchun `not_tested`.
