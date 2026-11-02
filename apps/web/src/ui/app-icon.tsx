import { MonitorPlay } from 'lucide-react';
import { cn } from './cn.ts';

// Ilova belgisi: macOS ikonkasi kabi yumaloq kvadrat, ichida monitor.
export function AppIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7 place-items-center rounded-[7px] bg-gradient-to-b from-[#3d9bff] to-[#0062e0] text-white shadow-control',
        className,
      )}
    >
      <MonitorPlay className="size-[60%]" strokeWidth={2} />
    </span>
  );
}
