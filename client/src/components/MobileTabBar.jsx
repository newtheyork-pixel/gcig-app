import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  LineChart,
  MessageSquare,
  CalendarDays,
  Menu,
} from 'lucide-react';

// Bottom tab bar for phone-sized viewports. Gives the app a native feel
// instead of always relying on a hamburger drawer. The "More" tab opens the
// full sidebar drawer for everything that doesn't fit in the primary five.
//
// Uses `env(safe-area-inset-bottom)` so the iPhone home-indicator doesn't
// overlap the icons. Sits above all page content via z-40 and is gated to
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
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-navy-100 bg-white shadow-[0_-4px_12px_rgba(27,42,74,0.08)] md:hidden"
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
              `flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold transition ${
                isActive ? 'text-navy' : 'text-navy-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={`h-5 w-5 ${isActive ? 'text-gold' : ''}`} />
                <span>{t.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
      <button
        onClick={onOpenMore}
        className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold text-navy-400 transition hover:text-navy"
      >
        <Menu className="h-5 w-5" />
        <span>More</span>
      </button>
    </nav>
  );
}
