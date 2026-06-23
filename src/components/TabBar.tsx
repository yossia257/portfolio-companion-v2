import { Briefcase, FileText, Zap, Eye, MessageCircle, Settings } from 'lucide-react'

type TabKey = 'portfolio' | 'rsu' | 'signals' | 'watchlist' | 'ask-claude' | 'settings'

interface Tab {
  key: TabKey
  label: string
  Icon: React.ComponentType<{ className: string }>
}

const TABS: Tab[] = [
  { key: 'portfolio', label: 'Portfolio', Icon: Briefcase },
  { key: 'rsu', label: 'RSU', Icon: FileText },
  { key: 'signals', label: 'Signals', Icon: Zap },
  { key: 'watchlist', label: 'Watchlist', Icon: Eye },
  { key: 'ask-claude', label: 'Ask Claude', Icon: MessageCircle },
  { key: 'settings', label: 'Settings', Icon: Settings },
]

export default function TabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
}) {
  return (
    <div className="bg-gray-950 border-b border-gray-800 overflow-x-auto scrollbar-hide relative">
      <div className="flex gap-0 px-6 snap-x snap-mandatory">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`py-3 px-4 font-medium transition-colors relative flex-shrink-0 snap-start flex items-center gap-2 ${
              activeTab === tab.key
                ? 'text-accent border-b-2 border-accent'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <tab.Icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>
      {/* Subtle gradient hint for more content */}
      <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-gray-950 pointer-events-none" />
    </div>
  )
}
