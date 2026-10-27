// MeshCentral device rights bitlari (upstream meshuser.js:40-64).
const MESHRIGHT_REMOTECONTROL = 0x00000008;
const MESHRIGHT_REMOTEVIEWONLY = 0x00000100;
const MESHRIGHT_NOTERMINAL = 0x00000200;
const MESHRIGHT_NOFILES = 0x00000400;
const MESHRIGHT_NOAMT = 0x00000800;
const MESHRIGHT_NOREGISTRY = 0x00400000;
const MESHRIGHT_NOSOFTWARE = 0x00800000;

// Sessiya principal'i faqat desktop oladi: terminal, fayllar, AMT, registry va software tunnellari yopiq.
export const CONTROL_RIGHTS =
  MESHRIGHT_REMOTECONTROL |
  MESHRIGHT_NOTERMINAL |
  MESHRIGHT_NOFILES |
  MESHRIGHT_NOAMT |
  MESHRIGHT_NOREGISTRY |
  MESHRIGHT_NOSOFTWARE;
export const VIEW_RIGHTS = CONTROL_RIGHTS | MESHRIGHT_REMOTEVIEWONLY;

// Site huquqlari (meshuser.js SITERIGHT_*): principal guruh yarata olmaydi, sozlamalarni o'zgartira olmaydi,
// qurilma qo'sha olmaydi. siteadmin: 0 bularni ochiq qoldirardi (createmesh faqat NONEWGROUPS'ni tekshiradi).
const SITERIGHT_NONEWGROUPS = 0x00000040;
const SITERIGHT_LOCKSETTINGS = 0x00000400;
const SITERIGHT_NONEWDEVICES = 0x00001000;
export const PRINCIPAL_SITE_RIGHTS = SITERIGHT_NONEWGROUPS | SITERIGHT_LOCKSETTINGS | SITERIGHT_NONEWDEVICES;

export function rightsFor(mode: 'view' | 'control'): number {
  return mode === 'view' ? VIEW_RIGHTS : CONTROL_RIGHTS;
}
