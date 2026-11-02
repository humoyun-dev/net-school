// Miniatura chegaralari: server bergan interval va kadr limitlari (P1e); kadr hech qayerga yozilmaydi.
export const THUMBNAIL_INTERVAL_MS = 1_000;
export const THUMBNAIL_CLIENT_MIN_INTERVAL_MS = 500; // Companion bundan tez yubormaydi
export const THUMBNAIL_SERVER_MIN_INTERVAL_MS = 400; // Hub bundan tez kelgan kadrni tashlaydi
export const THUMBNAIL_MAX_WIDTH = 480;
export const THUMBNAIL_MAX_BYTES = 262_144;
export const THUMBNAIL_TTL_MS = 10_000; // Hub har qurilmaning oxirgi kadrini shuncha saqlaydi
