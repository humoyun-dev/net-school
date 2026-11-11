package session

// LaunchOptions foydalanuvchi nomidan ishga tushiriladigan jarayonning himoyasi. Nol qiymat eng xavfsiz holat:
// jarayon va birinchi ip ProcessSDDL/ThreadSDDL bilan (o'quvchi faqat 0x121000/0x120800) va muhit sanitizedEnv
// bilan tozalangan (`HKCU\Environment`dagi NODE_*/ELECTRON_* va boshqalar tashlanadi, Path tizimniki). Kim
// himoyadan voz kechsa, buni maydon bilan aniq aytadi (ShellLaunch): yangi chaqiruvchi tasodifan himoyasiz
// jarayon ochmaydi.
type LaunchOptions struct {
	// DefaultSecurity — jarayon va ip token'ning standart SD'si bilan (nil lpProcessAttributes/lpThreadAttributes):
	// o'quvchi o'z jarayonini boshqaradi (Task Manager'dan qayta ishga tushirish va h.k.).
	DefaultSecurity bool
	// FullEnv — foydalanuvchining to'liq muhiti (CreateEnvironmentBlock(tok, false), filtrsiz): o'quvchining
	// o'z Path'i va boshqa o'zgaruvchilari saqlanadi.
	FullEnv bool
}

var (
	// CompanionLaunch — Companion: himoyalangan SD va tozalangan muhit (nol qiymat, aniq yozilgan).
	CompanionLaunch = LaunchOptions{}
	// ShellLaunch — explorer: oddiy foydalanuvchi jarayoni. Undan ochilgan har dastur muhitni meros oladi,
	// shuning uchun tozalangan muhit o'quvchining hamma dasturlarini logoff'gacha buzardi; himoyalangan SD esa
	// o'quvchiga o'z shell'ini boshqarishga yo'l qo'ymasdi.
	ShellLaunch = LaunchOptions{DefaultSecurity: true, FullEnv: true}
)

// SanitizedEnv muhit sanitizedEnv bilan tozalanadimi.
func (o LaunchOptions) SanitizedEnv() bool { return !o.FullEnv }

// descriptors jarayon va ip SDDL'lari. Bo'sh satr — standart SD (nil SECURITY_ATTRIBUTES).
func (o LaunchOptions) descriptors(userSID string) (proc, thread string, err error) {
	if o.DefaultSecurity {
		return "", "", nil
	}
	if proc, err = ProcessSDDL(userSID); err != nil {
		return "", "", err
	}
	if thread, err = ThreadSDDL(userSID); err != nil {
		return "", "", err
	}
	return proc, thread, nil
}
