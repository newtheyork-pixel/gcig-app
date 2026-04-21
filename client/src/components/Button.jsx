// Editorial button. Same API as before (variant + children). Styling
// tightened to match the Landing page's typographic rhythm — slightly
// more letter-spacing, more restrained hovers.

const VARIANTS = {
  primary:
    'bg-navy text-white hover:bg-navy-700 border border-navy',
  gold:
    'bg-gold text-navy hover:bg-gold-600 hover:text-white border border-gold',
  outline:
    'border border-navy-100 bg-white text-navy hover:border-navy hover:bg-white',
  ghost:
    'border border-transparent bg-transparent text-navy hover:bg-navy-50',
  danger:
    'bg-red-600 text-white hover:bg-red-700 border border-red-600',
};

export default function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  children,
  ...props
}) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold tracking-[0.01em] transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
