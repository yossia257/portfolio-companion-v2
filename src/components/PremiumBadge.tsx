import { Lock } from 'lucide-react'

interface PremiumBadgeProps {
  size?: 'sm' | 'md'
  showText?: boolean
}

export default function PremiumBadge({ size = 'sm', showText = true }: PremiumBadgeProps) {
  const sizeClasses = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'
  const containerClasses = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-2.5 py-1.5 text-sm'

  return (
    <div className={`inline-flex items-center gap-1 rounded-full bg-amber-500/20 border border-amber-500/50 text-amber-400 ${containerClasses}`}>
      <Lock className={sizeClasses} strokeWidth={2.5} />
      {showText && <span className="font-semibold">Premium</span>}
    </div>
  )
}
