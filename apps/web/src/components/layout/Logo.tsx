import { cn } from '@/lib/utils'

/**
 * The Shivoraa mark, matching shivoraa.in.
 *
 * Drawn as SVG rather than loading the site's PNG: it stays crisp at any size,
 * needs no cross-origin request, and cannot break if the marketing site's
 * asset paths change.
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cn('shrink-0', className)}
      role="img"
      aria-label="Shivoraa"
    >
      <defs>
        <linearGradient id="sv-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FF9446" />
          <stop offset="100%" stopColor="#C05E12" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="url(#sv-mark)" />
      <text
        x="16"
        y="23"
        fontSize="19"
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight="700"
        fill="#fff"
        textAnchor="middle"
      >
        S
      </text>
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Logo size={26} />
      <span className="text-sm font-bold tracking-tight">
        SHIVORAA <span className="font-medium text-muted">Studio</span>
      </span>
    </span>
  )
}
