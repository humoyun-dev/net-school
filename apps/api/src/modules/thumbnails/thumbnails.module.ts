import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { ThumbnailIngest } from './thumbnail-ingest.ts';
import { ThumbnailStore } from './thumbnail-store.ts';
import { ThumbnailsController } from './thumbnails.controller.ts';

@Module({
  controllers: [ThumbnailsController],
  providers: [Access, ThumbnailStore, ThumbnailIngest],
  exports: [ThumbnailStore],
})
export class ThumbnailsModule {}
