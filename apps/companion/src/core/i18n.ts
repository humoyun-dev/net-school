export type Locale = 'uz' | 'ru' | 'en';

const uz = {
  statusTitle: 'NetSchool Companion',
  notEnrolled: "Kompyuter ro'yxatdan o'tmagan — IT xizmatiga murojaat qiling",
  enrollmentBroken: "Companion sozlamalari buzilgan yoki o'qib bo'lmaydi — IT xizmatiga murojaat qiling",
  hubOnline: 'Ulangan',
  hubConnecting: 'Ulanmoqda…',
  hubOffline: "Hub bilan aloqa yo'q",
  hubLastSeen: 'Oxirgi aloqa',
  hubTlsError: "Xavfsiz ulanish tekshiruvidan o'tmadi",
  hubRejected: 'Qurilma hub tomonidan rad etildi',
  lessonActive: 'Dars davom etmoqda',
  lessonNone: "Hozir dars yo'q",
  overlayTitle: "Ekran o'qituvchi tomonidan vaqtincha qulflangan",
  overlayNote: 'Yumshoq bloklash — dars davom etmoqda',
  overlayNoteHard: 'Bloklangan — dars davom etmoqda',
  helpRaise: "Yordam so'rash",
  helpWithdraw: "So'rovni bekor qilish",
  helpSent: "Yordam so'rovi yuborildi",
  helpFailed: "Yordam so'rovini yuborib bo'lmadi",
  thumbnailsOn: "O'qituvchi ekraningiz miniaturasini ko'ryapti",
  thumbnailsNeedPermission: 'Ekran ulashish uchun tizim ruxsati kerak',
  thumbnailsUnsupported: "Bu kompyuterda ekran miniaturasi qo'llab-quvvatlanmaydi",
  messageTitle: "O'qituvchidan xabar",
  messageOk: 'OK',
  trayOpenStatus: "Holatni ko'rsatish",
};

export type StringKey = keyof typeof uz;

const ru: Record<StringKey, string> = {
  statusTitle: 'NetSchool Companion',
  notEnrolled: 'Компьютер не зарегистрирован — обратитесь в ИТ-службу',
  enrollmentBroken: 'Настройки Companion повреждены или недоступны — обратитесь в ИТ-службу',
  hubOnline: 'Подключено',
  hubConnecting: 'Подключение…',
  hubOffline: 'Нет связи с хабом',
  hubLastSeen: 'Последняя связь',
  hubTlsError: 'Безопасное соединение не прошло проверку',
  hubRejected: 'Устройство отклонено хабом',
  lessonActive: 'Идёт урок',
  lessonNone: 'Сейчас урока нет',
  overlayTitle: 'Экран временно заблокирован учителем',
  overlayNote: 'Мягкая блокировка — урок продолжается',
  overlayNoteHard: 'Заблокировано — урок продолжается',
  helpRaise: 'Попросить помощи',
  helpWithdraw: 'Отменить запрос',
  helpSent: 'Запрос помощи отправлен',
  helpFailed: 'Не удалось отправить запрос помощи',
  thumbnailsOn: 'Учитель видит миниатюру вашего экрана',
  thumbnailsNeedPermission: 'Для показа экрана нужно разрешение системы',
  thumbnailsUnsupported: 'Миниатюра экрана на этом компьютере не поддерживается',
  messageTitle: 'Сообщение от учителя',
  messageOk: 'OK',
  trayOpenStatus: 'Показать состояние',
};

const en: Record<StringKey, string> = {
  statusTitle: 'NetSchool Companion',
  notEnrolled: 'This computer is not enrolled — contact IT support',
  enrollmentBroken: 'Companion settings are damaged or unreadable — contact IT support',
  hubOnline: 'Connected',
  hubConnecting: 'Connecting…',
  hubOffline: 'No connection to the hub',
  hubLastSeen: 'Last contact',
  hubTlsError: 'The secure connection failed verification',
  hubRejected: 'This device was rejected by the hub',
  lessonActive: 'A lesson is in progress',
  lessonNone: 'No lesson right now',
  overlayTitle: 'The screen is temporarily locked by your teacher',
  overlayNote: 'Soft lock — the lesson is in progress',
  overlayNoteHard: 'Locked — the lesson is in progress',
  helpRaise: 'Ask for help',
  helpWithdraw: 'Cancel request',
  helpSent: 'Help request sent',
  helpFailed: 'Could not send the help request',
  thumbnailsOn: 'Your teacher can see a thumbnail of your screen',
  thumbnailsNeedPermission: 'System permission is needed to share the screen',
  thumbnailsUnsupported: 'Screen thumbnails are not supported on this computer',
  messageTitle: 'Message from your teacher',
  messageOk: 'OK',
  trayOpenStatus: 'Show status',
};

export const strings: Record<Locale, Record<StringKey, string>> = { uz, ru, en };

// Tizim tili: ru/en bo'lsa shu, qolgan hamma holatda o'zbekcha.
export function pickLocale(appLocale: string): Locale {
  const lang = appLocale.toLowerCase();
  if (lang.startsWith('ru')) return 'ru';
  if (lang.startsWith('en')) return 'en';
  return 'uz';
}
