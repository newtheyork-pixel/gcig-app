import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import MobileTabBar from './MobileTabBar.jsx';
import VoteNotification from './VoteNotification.jsx';
import PitchNotification from './PitchNotification.jsx';

export default function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-full bg-[#EFECE6]">
      <VoteNotification />
      <PitchNotification />

      {/* Desktop sidebar — hidden below md */}
      <div className="hidden md:block shrink-0">
        <Sidebar />
      </div>

      {/* Mobile "More" drawer — overflow nav from the tab bar */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 md:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            className="absolute inset-y-0 left-0"
            onClick={(e) => e.stopPropagation()}
          >
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <main className="relative flex-1 overflow-y-auto">
        {/* Extra bottom padding on mobile so the tab bar doesn't cover the
            last row of content. Desktop gets the normal py-8. */}
        <div className="relative mx-auto max-w-6xl px-4 pt-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:px-10 md:pt-10 md:pb-12">
          <Outlet />
        </div>
      </main>

      <MobileTabBar onOpenMore={() => setDrawerOpen(true)} />
    </div>
  );
}
