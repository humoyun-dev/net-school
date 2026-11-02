import { Module } from '@nestjs/common';
import { ThumbnailIngest } from './thumbnail-ingest.ts';
import { ThumbnailStore } from './thumbnail-store.ts';

@Module({
  providers: [ThumbnailStore, ThumbnailIngest],
  exports: [ThumbnailStore],
})
export class ThumbnailsModule {}
