export type Role = 'school_admin' | 'teacher' | 'it_support' | 'student';

export const ROLES: readonly Role[] = ['school_admin', 'teacher', 'it_support', 'student'];

// siteId null — butun tashkilot bo'yicha (faqat school_admin uchun ruxsat etilgan ko'lam).
export interface RoleAssignment {
  role: Role;
  organizationId: string;
  siteId: string | null;
}

export interface Actor {
  userId: string;
  organizationId: string;
  assignments: readonly RoleAssignment[];
  roomIds: readonly string[]; // teacher biriktirilgan xonalar
}
