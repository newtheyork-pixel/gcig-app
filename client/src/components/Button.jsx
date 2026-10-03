const VARIANTS = {
  primary: 'bg-navy text-white hover:bg-navy-700',
  gold: 'bg-gold text-navy hover:bg-gold-400',
  outline: 'border border-black/10 bg-white text-navy hover:bg-black/[0.03]',
  ghost: 'text-navy hover:bg-black/[0.04]',
  danger: 'bg-red-600 text-white hover:bg-red-700',
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
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
