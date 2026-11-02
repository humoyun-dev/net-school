import { desktopCapturer, screen } from 'electron';
import type { FrameSource } from '../core/thumbnails.ts';

const JPEG_QUALITY = 60;

// Asosiy displeyning kichraytirilgan JPEG kadri (spec §11). Bo'sh kadr null: ruxsat yo'q yoki displey tayyor emas.
export class ElectronFrameSource implements FrameSource {
  async capture(maxWidth: number): Promise<Buffer | null> {
    const display = screen.getPrimaryDisplay();
    const scale = Math.min(1, maxWidth / display.size.width);
    const thumbnailSize = {
      width: Math.max(1, Math.round(display.size.width * scale)),
      height: Math.max(1, Math.round(display.size.height * scale)),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;
    return source.thumbnail.toJPEG(JPEG_QUALITY);
  }
}
