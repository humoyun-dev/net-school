import { Controller, Get, Inject, Param, Req, Res, StreamableFile } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Access } from '../../common/access.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import { requestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { devices, lessonDevices, lessons } from '../../db/schema.ts';
import { ThumbnailStore } from './thumbnail-store.ts';

// Dars egasi (teacher yoki admin) uchun qurilmaning oxirgi kadri. Muvaffaqiyatli o'qish audit qilinmaydi,
// kadr diskka yozilmaydi: javob xotiradagi baytlar.
@Controller('api/v1/lessons/:lessonId/devices/:deviceId/thumbnail')
export class ThumbnailsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(Access) private readonly access: Access,
    @Inject(ThumbnailStore) private readonly store: ThumbnailStore,
  ) {}

  @Get()
  async latest(
    @Param('lessonId') lessonId: string,
    @Param('deviceId') deviceId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const ctx = requestContext(req);
    const actor = this.access.actor(ctx);
    // Noma'lum, begona va noto'g'ri formatli ID'lar bir xil audit qilingan 403 beradi.
    const [lesson] = isUuid(lessonId)
      ? await this.db
          .select()
          .from(lessons)
          .where(and(eq(lessons.id, lessonId), eq(lessons.organizationId, actor.organizationId)))
      : [];
    if (!lesson) return this.access.deny(ctx, 'remote.view', { targetType: 'lesson', targetId: lessonId });
    await this.access.require(
      ctx,
      'remote.view',
      {
        organizationId: lesson.organizationId,
        siteId: lesson.siteId,
        roomId: lesson.roomId,
        ownerUserId: lesson.teacherUserId,
      },
      { targetType: 'lesson', targetId: lesson.id },
    );
    if (!(isUuid(deviceId) && (await this.#isMember(lesson.id, deviceId)))) {
      return this.access.deny(ctx, 'remote.view', { targetType: 'device', targetId: deviceId }, lesson.siteId);
    }

    const frame = this.store.latest(deviceId, lesson.id);
    if (!frame) throw new ApiError('not_found', 'No recent frame');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-ns-frame-seq', String(frame.seq));
    res.setHeader('x-ns-frame-at', new Date(frame.at).toISOString());
    // Buffer'ni Nest JSON qilib yuborardi; StreamableFile xom baytlarni beradi.
    return new StreamableFile(frame.jpeg, { type: 'image/jpeg', length: frame.jpeg.length });
  }

  // Qurilma darsning faol (bo'shatilmagan) a'zosi va yopilmagan.
  async #isMember(lessonId: string, deviceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ deviceId: lessonDevices.deviceId })
      .from(lessonDevices)
      .innerJoin(devices, eq(devices.id, lessonDevices.deviceId))
      .where(
        and(
          eq(lessonDevices.lessonId, lessonId),
          eq(lessonDevices.deviceId, deviceId),
          isNull(lessonDevices.releasedAt),
          isNull(devices.retiredAt),
        ),
      );
    return rows.length > 0;
  }
}
