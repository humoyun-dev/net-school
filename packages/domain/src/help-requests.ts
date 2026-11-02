// Yordam so'rovi (qo'l ko'tarish) matnsiz; bir (dars, qurilma) uchun eng ko'pi bitta ochiq so'rov.
// teacher — dars egasi yoki admin; device — o'quvchi o'zi; lesson_ended — dars tugadi; device_left — qurilma xonadan chiqdi.
export type HelpClearReason = 'teacher' | 'device' | 'lesson_ended' | 'device_left';
