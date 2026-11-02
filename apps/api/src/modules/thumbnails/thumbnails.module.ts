import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { IdentityModule } from '../identity/identity.module.ts';
import { ThumbnailIngest } from './thumbnail-ingest.ts';
import { ThumbnailStore } from './thumbnail-store.ts';
import { ThumbnailStream } from './thumbnail-stream.ts';
import { ThumbnailsController } from './thumbnails.controller.ts';

@Module({
  imports: [IdentityModule],
  controllers: [ThumbnailsController],
  providers: [Access, ThumbnailStore, ThumbnailIngest, ThumbnailStream],
  exports: [ThumbnailStore, ThumbnailStream],
})
export class ThumbnailsModule {}
