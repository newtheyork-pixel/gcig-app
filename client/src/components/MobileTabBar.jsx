import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  LineChart,
  MessageSquare,
  CalendarDays,
  Menu,
} from 'lucide-react';

// Bottom tab bar for phone-sized viewports. The "More" tab opens the
// full sidebar drawer for everything that doesn't fit in the primary four.
//
// Uses `env(safe-area-inset-bottom)` so the iPhone home-indicator doesn't
// overlap the icons. Sits above page content via z-40 and is gated to
// mobile only with `md:hidden`.

const TABS = [
  { to: '/dashboard', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/portfolio', label: 'Portfolio', icon: LineChart },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
];

export default function MobileTabBar({ onOpenMore }) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-black/[0.08] bg-white/95 backdrop-blur md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Primary"
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        return (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition ${
                isActive ? 'text-navy' : 'text-navy-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`absolute inset-x-3 top-0 h-0.5 rounded-full ${
                    isActive ? 'bg-gold' : 'bg-transparent'
                  }`}
                />
                <Icon className="h-5 w-5" />
                <span>{t.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
      <button
        onClick={onOpenMore}
        className="relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium text-navy-400 transition hover:text-navy"
      >
        <Menu className="h-5 w-5" />
        <span>More</span>
      </button>
    </nav>
  );
}
