import { z } from 'zod';

export const nameSchema = z.string().trim().min(1).max(100);

export const createSiteRequestSchema = z.strictObject({ name: nameSchema });
export const createRoomRequestSchema = z.strictObject({ name: nameSchema });
export const updateRoomRequestSchema = z.strictObject({ name: nameSchema });

export const siteSchema = z.object({ id: z.uuid(), name: z.string() });
export const roomSchema = z.object({ id: z.uuid(), siteId: z.uuid(), name: z.string() });
export type Site = z.infer<typeof siteSchema>;
export type Room = z.infer<typeof roomSchema>;
