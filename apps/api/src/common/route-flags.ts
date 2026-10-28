import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'ns:public';
export const ALLOW_DURING_PASSWORD_CHANGE = 'ns:allow-password-change';
export const DEVICE_ROUTE = 'ns:device';

// Sessiyasiz ochiq marshrut (login, healthz).
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
// Parol almashtirish majburiy bo'lganda ham ruxsat etilgan marshrut.
export const AllowDuringPasswordChange = () => SetMetadata(ALLOW_DURING_PASSWORD_CHANGE, true);
// Qurilma marshruti: sessiya cookie va Origin o'rniga qurilma imzosi (DeviceAuthGuard) yoki claim token.
export const DeviceRoute = () => SetMetadata(DEVICE_ROUTE, true);
