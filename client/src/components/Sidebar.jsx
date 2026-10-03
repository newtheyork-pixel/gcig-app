import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Mic,
  LayoutDashboard,
  CalendarDays,
  LineChart,
  BookOpen,
  ClipboardCheck,
  LogOut,
  Vote,
  Building2,
  ShieldAlert,
  MessageSquare,
  Trophy,
  Megaphone,
  Bot,
  Send,
  Terminal,
  Download,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { griffinLogo } from '../brand/logos.js';
import RoleBadge from './RoleBadge.jsx';
import api from '../api/client.js';

// Everyday destinations stay on screen. Everything else lives in one
// collapsed More group so the nav is a short list instead of a catalog.
// The web terminal is a single gold row rather than a sticky banner.
const NAV_SECTIONS = [
  {
    items: [
      { to: '/terminal', label: 'Terminal', icon: Terminal, terminalAccess: true, emphasis: true },
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/portfolio', label: 'Portfolio', icon: LineChart },
      { to: '/votes', label: 'Voting', icon: Vote },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/chat', label: 'Chat', icon: MessageSquare },
      { to: '/field-research', label: 'Fieldwork', icon: Mic },
      { to: '/ai-chat', label: 'Assistant', icon: Bot },
    ],
  },
  {
    header: 'More',
    collapsible: true,
    items: [
      { to: '/library', label: 'Library', icon: BookOpen },
      { to: '/outcomes', label: 'Coverage', icon: Trophy },
      { to: '/industries', label: 'Industries', icon: Building2 },
      { to: '/pitch-requests', label: 'Pitch Requests', icon: Send, badgeKey: 'pitchRequests' },
      { to: '/attendance', label: 'Attendance', icon: ClipboardCheck, hideForAdvisory: true },
      { to: '/broadcast', label: 'Broadcast', icon: Megaphone, executiveOnly: true },
      { to: '/download', label: 'Mac app', icon: Download },
      { to: '/admin', label: 'Admin', icon: ShieldAlert, pmOrAbove: true },
    ],
  },
];

const MORE_NAV_KEY = 'gcig_nav_more';

function itemIsActive(pathname, item) {
  return (
    pathname === item.to ||
    (item.to !== '/' && pathname.startsWith(item.to + '/'))
  );
}

export default function Sidebar({ onNavigate }) {
  const { user, logout, isAdmin, isExecutive, isPmOrAbove, isAdvisory, isSuperAdmin, isAnalystOrAbove } = useAuth();
  const location = useLocation();
  const [badges, setBadges] = useState({ pitchRequests: 0 });
  const [moreCollapsed, setMoreCollapsed] = useState(() => {
    try {
      return localStorage.getItem(MORE_NAV_KEY) !== 'open';
    } catch {
      return true;
    }
  });

  // Poll the pending-pitch-requests count so the sidebar chip stays fresh.
  // 60s cadence is plenty for an inbox-style notification — anything more
  // aggressive just spams the API for nothing.
  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const { data } = await api.get('/pitch-requests/pending-count');
        if (cancelled) return;
        setBadges({ pitchRequests: (data.count || 0) + (data.mineUnseen || 0) });
      } catch {
        /* ignore — badge defaults to 0 */
      }
    }
    pull();
    const t = setInterval(pull, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  function toggleMore() {
    setMoreCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(MORE_NAV_KEY, next ? 'closed' : 'open');
      } catch {
        /* private mode */
      }
      return next;
    });
  }

  function isVisible(item) {
    return (
      (!item.adminOnly || isAdmin) &&
      (!item.executiveOnly || isExecutive) &&
      (!item.executiveOrAdvisory || isExecutive || isAdvisory) &&
      (!item.pmOrAbove || isPmOrAbove) &&
      (!item.superAdminOnly || isSuperAdmin) &&
      (!item.hideForAdvisory || !isAdvisory) &&
      (!item.terminalAccess || isAnalystOrAbove || isAdvisory)
    );
  }

  return (
    <aside className="flex h-full w-56 flex-col border-r border-navy/10 bg-[#F7F5F0] text-navy">
      <div className="px-5 pb-4 pt-5">
        <img
          src={griffinLogo}
          alt="The Griffin Fund"
          width={1091}
          height={458}
          className="h-11 w-auto max-w-full"
        />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {NAV_SECTIONS.map((section, sectionIdx) => {
          const visible = section.items.filter(isVisible);
          if (visible.length === 0) return null;

          const onThisSection = visible.some((i) =>
            itemIsActive(location.pathname, i)
          );
          const hideItems =
            section.collapsible && moreCollapsed && !onThisSection;
          const hiddenBadge = hideItems
            ? visible.reduce((n, i) => n + (i.badgeKey ? badges[i.badgeKey] || 0 : 0), 0)
            : 0;

          return (
            <div key={sectionIdx} className={sectionIdx === 0 ? 'mb-1' : 'mt-3 mb-1'}>
              {section.header &&
                (section.collapsible ? (
                  <button
                    type="button"
                    onClick={toggleMore}
                    className="mb-1 flex w-full cursor-pointer items-center gap-2 px-2.5 py-1 text-[11px] font-medium text-navy-400 hover:text-navy"
                    aria-expanded={!hideItems}
                  >
                    <span className="flex-1 text-left">{section.header}</span>
                    {hiddenBadge > 0 && (
                      <span className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-navy px-1.5 text-[10px] font-semibold tracking-normal text-white">
                        {hiddenBadge}
                      </span>
                    )}
                    <ChevronDown
                      className={`h-3 w-3 transition-transform ${hideItems ? '-rotate-90' : ''}`}
                    />
                  </button>
                ) : (
                  <div className="mb-1 flex w-full items-center gap-2 px-2.5 py-1 text-[11px] font-medium text-navy-400">
                    {section.header}
                  </div>
                ))}
              {!hideItems && (
                <div className="space-y-0.5">
                  {visible.map((item) => {
                    const Icon = item.icon;
                    const badge = item.badgeKey ? badges[item.badgeKey] : 0;
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          `flex items-center gap-2.5 rounded-md border-l-2 px-2.5 py-1.5 text-[13px] transition ${
                            isActive
                              ? 'border-gold bg-white font-semibold text-navy'
                              : 'border-transparent font-medium text-navy-400 hover:bg-white/70 hover:text-navy'
                          }`
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <Icon
                              className={`h-4 w-4 shrink-0 ${
                                item.emphasis && !isActive ? 'text-gold-700' : ''
                              }`}
                            />
                            <span className="flex-1">{item.label}</span>
                            {badge > 0 && (
                              <span
                                className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-navy px-1.5 text-[10px] font-semibold text-white"
                              >
                                {badge}
                              </span>
                            )}
                          </>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-navy/10 p-3">
        <NavLink
          to="/profile"
          onClick={onNavigate}
          aria-label="Profile"
          className={({ isActive }) =>
            `mb-1 block rounded-md px-2.5 py-2 transition ${
              isActive ? 'bg-white' : 'hover:bg-white/70'
            }`
          }
        >
          <div className="truncate text-sm font-semibold text-navy">{user?.name}</div>
          <div className="mt-1">
            <RoleBadge role={user?.role} />
          </div>
        </NavLink>
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] font-medium text-navy-400 transition hover:bg-white/70 hover:text-navy"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
