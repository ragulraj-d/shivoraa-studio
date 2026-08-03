import { cn } from '@/lib/utils'

/**
 * The Shivoraa Studio mark.
 *
 * Served from /public rather than imported, so the same file backs the favicon,
 * the manifest icons and the in-app logo — one asset, no chance of the tab icon
 * drifting from the header.
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/icon-192.png"
      width={size}
      height={size}
      alt=""
      // Decorative here: every place it appears is next to the word Shivoraa,
      // so announcing it again would just repeat the name to a screen reader.
      aria-hidden="true"
      className={cn('shrink-0 select-none object-contain', className)}
      style={{ width: size, height: size }}
    />
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Logo size={32} />
      <span className="text-sm font-bold tracking-tight">
        SHIVORAA <span className="font-medium text-muted">Studio</span>
      </span>
    </span>
  )
}
