# Capability matrix (P0c)

Har katakning holati:
- `not_tested` — sinovdan o'tmagan;
- `passed`, `partial` yoki `failed` — qavs ichida dalil bilan, masalan `passed (results/windows-x64-2026-11-03.json#remote)` yoki `partial (results/windows-x64-2026-11-03-manual.md)`.

`passed` dalilsiz qo'yilmaydi. CI har push'da `node scripts/poc/matrix.mjs` bilan tekshiradi (spec §7: hech bir OS sinovsiz "qo'llanadi" deb belgilanmaydi).

| Imkoniyat | Windows x64 | Windows ARM64 | macOS | Linux X11 | Linux Wayland |
|---|---|---|---|---|---|
| `enrollment` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `inventory` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `remote.view` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `remote.control` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `remote.view_only_blocks_input` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `remote.revoke` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `power.shutdown` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `power.reboot` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `power.sleep` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `power.wake` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `classroom.message` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `classroom.overlay` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `classroom.overlay_lease_expiry` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `classroom.help` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `classroom.thumbnails` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `uac_secure_desktop` | not_tested | not_tested | not_tested | not_tested | not_tested |
| `multi_monitor` | not_tested | not_tested | not_tested | not_tested | not_tested |

Hozircha sinov uchun faqat Windows mashinasi bor (egasi, 2026-11-02). macOS va Linux ustunlari mashina paydo bo'lguncha `not_tested` bo'lib qoladi.
