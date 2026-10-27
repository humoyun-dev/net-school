// MeshCentral device rights bitlari (upstream meshuser.js:40-64).
const MESHRIGHT_REMOTECONTROL = 0x00000008;
const MESHRIGHT_REMOTEVIEWONLY = 0x00000100;
const MESHRIGHT_NOTERMINAL = 0x00000200;
const MESHRIGHT_NOFILES = 0x00000400;
const MESHRIGHT_NOAMT = 0x00000800;

// Sessiya principal'i faqat desktop oladi: terminal, fayllar va AMT yopiq.
export const CONTROL_RIGHTS = MESHRIGHT_REMOTECONTROL | MESHRIGHT_NOTERMINAL | MESHRIGHT_NOFILES | MESHRIGHT_NOAMT;
export const VIEW_RIGHTS = CONTROL_RIGHTS | MESHRIGHT_REMOTEVIEWONLY;

export function rightsFor(mode: 'view' | 'control'): number {
  return mode === 'view' ? VIEW_RIGHTS : CONTROL_RIGHTS;
}
