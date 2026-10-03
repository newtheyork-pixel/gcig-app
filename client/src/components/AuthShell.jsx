import AuthBrandMark from './AuthBrandMark.jsx';

export const authFieldClass =
  'mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm text-navy outline-none transition placeholder:text-navy-200 focus:border-navy focus:ring-2 focus:ring-navy/10';

export const authLinkClass = 'text-sm font-medium text-navy-500 hover:text-navy';

// Shared frame for sign-in, invite, and password pages.
export default function AuthShell({ children, footer }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-[#EFECE6] px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <AuthBrandMark />
        </div>
        <div className="rounded-2xl border border-black/[0.08] bg-white px-6 py-7 shadow-[0_1px_2px_rgba(13,22,38,0.04)] sm:px-8">
          {children}
        </div>
        {footer ? (
          <p className="mt-4 text-center text-xs leading-relaxed text-navy-400">{footer}</p>
        ) : null}
      </div>
    </div>
  );
}
