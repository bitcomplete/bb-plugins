/** Self improve's mark: an improvement loop around a rising line. Mirrors icons/self-improve.svg. */
export function LoopIcon({ className, size = 24 }: { className?: string; size?: number }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/><path d="M9.5 14l2-2 1.5 1.5 1.5-1.5"/>
  </svg>;
}
