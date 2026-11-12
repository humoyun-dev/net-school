import { ChevronsUpDown, DoorOpen, LogOut, Power, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { hasRole, useMe, useSession } from '../auth/session.tsx';
import { useI18n } from '../i18n/i18n.tsx';
import { LOCALES, type Locale } from '../i18n/strings.ts';
import { RoomsContext, useMyRooms } from '../rooms/use-rooms.ts';
import { AppIcon } from '../ui/app-icon.tsx';
import { cn } from '../ui/cn.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import { TooltipProvider } from '../ui/tooltip.tsx';

const LOCALE_NAMES: Record<Locale, string> = { uz: "O'zbekcha", ru: 'Русский', en: 'English' };

function SidebarLink(props: { to: string; icon: ReactNode; children: ReactNode; state?: unknown }) {
  return (
    <NavLink
      to={props.to}
      state={props.state}
      className={({ isActive }) =>
        cn(
          'flex h-7 items-center gap-2 rounded-[6px] px-2 text-[13px] text-foreground/90 hover:bg-hover',
          isActive && 'bg-black/[0.08] font-medium text-foreground dark:bg-white/[0.1]',
        )
      }
    >
      <span className="text-primary [&_svg]:size-[15px]">{props.icon}</span>
      <span className="truncate">{props.children}</span>
    </NavLink>
  );
}

function SectionLabel(props: { children: ReactNode }) {
  return <div className="px-2 pt-4 pb-1 text-[11px] font-semibold text-muted-foreground">{props.children}</div>;
}

function UserMenu() {
  const me = useMe();
  const { logout } = useSession();
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const initials = me.user.displayName
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('nav.account')}
        className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-hover"
      >
        <span className="grid size-6 place-items-center rounded-full bg-gradient-to-b from-[#a1a1aa] to-[#71717a] text-[10px] font-semibold text-white">
          {initials}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{me.user.displayName}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel>{t('locale.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={locale} onValueChange={(v) => setLocale(v as Locale)}>
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              {LOCALE_NAMES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await logout();
            navigate('/login', { replace: true });
          }}
        >
          <LogOut />
          {t('nav.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Shell() {
  const me = useMe();
  const { t } = useI18n();
  const rooms = useMyRooms();
  const canPower = hasRole(me, ['school_admin', 'it_support']);
  const roomLinks = (rooms.data ?? []).map(({ site, rooms: list }) => (
    <div key={site.id}>
      {(rooms.data?.length ?? 0) > 1 && (
        <div className="truncate px-2 pt-2 pb-0.5 text-[11px] text-muted-foreground">{site.name}</div>
      )}
      {list.map((r) => (
        <SidebarLink key={r.id} to={`/rooms/${r.id}`} state={{ name: r.name }} icon={<DoorOpen />}>
          {r.name}
        </SidebarLink>
      ))}
    </div>
  ));
  return (
    <TooltipProvider>
      <RoomsContext.Provider value={rooms}>
        <div className="flex min-h-dvh flex-col md:h-dvh md:flex-row">
          <aside className="flex shrink-0 flex-col border-separator bg-sidebar backdrop-blur-2xl max-md:border-b-[0.5px] md:w-[232px] md:border-r-[0.5px]">
            <div className="flex items-center gap-2 px-4 pt-4 pb-2">
              <AppIcon />
              <span className="font-display text-[14px] font-semibold">{t('app.title')}</span>
            </div>
            <nav
              aria-label={t('app.title')}
              className="flex-1 overflow-y-auto px-2 pb-2 max-md:flex max-md:gap-1 max-md:overflow-x-auto"
            >
              <div className="max-md:hidden">
                <NavLink end to="/rooms" className="block rounded-[4px] hover:text-foreground">
                  <SectionLabel>{t('nav.rooms')}</SectionLabel>
                </NavLink>
                {roomLinks}
              </div>
              <div className="md:hidden">
                <SidebarLink to="/rooms" icon={<DoorOpen />}>
                  {t('nav.rooms')}
                </SidebarLink>
              </div>
              {canPower && (
                <div>
                  <div className="max-md:hidden">
                    <SectionLabel>{t('nav.manage')}</SectionLabel>
                  </div>
                  <SidebarLink to="/power" icon={<Power />}>
                    {t('nav.power')}
                  </SidebarLink>
                  <SidebarLink to="/policies" icon={<ShieldCheck />}>
                    {t('nav.policies')}
                  </SidebarLink>
                </div>
              )}
            </nav>
            <div className="border-t-[0.5px] border-separator p-2">
              <UserMenu />
            </div>
          </aside>
          <main className="min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </RoomsContext.Provider>
    </TooltipProvider>
  );
}
