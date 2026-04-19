import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, children, size = 'md' }) {
  if (!open) return null;
  const sizes = {
    sm: 'md:max-w-sm',
    md: 'md:max-w-md',
    lg: 'md:max-w-2xl',
    xl: 'md:max-w-4xl',
    full: 'md:max-w-6xl',
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-navy/60 md:items-center md:p-4"
      onClick={onClose}
    >
      {/*
        Mobile: true full-screen sheet — no rounded corners, no padding around
        the dialog, content fills the viewport minus the tab bar.
        Desktop: centered card with max-width.
      */}
      <div
        className={`flex h-full w-full flex-col bg-white shadow-xl md:h-auto md:max-h-[90vh] md:overflow-hidden md:rounded-xl ${sizes[size]}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-navy-50 px-4 py-3 md:px-5 md:py-4">
          <h2 className="text-base font-semibold text-navy md:text-lg">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-navy-400 hover:bg-navy-50 hover:text-navy"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 md:p-5">{children}</div>
      </div>
    </div>
  );
}
