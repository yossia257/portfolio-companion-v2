export function Sparkline({ closes }: { closes: number[] | undefined }) {
  if (!closes?.length) return <span className="text-gray-500">—</span>

  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const range = max - min || 1

  const W = 80
  const H = 24

  const points = closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * W
      const y = H - ((c - min) / range) * H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const first = closes[0]
  const last = closes[closes.length - 1]
  const color = last > first ? '#10B981' : last < first ? '#EF4444' : '#6B7280'

  return (
    <svg width={W} height={H} className="inline-block" viewBox={`0 0 ${W} ${H}`}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  )
}
