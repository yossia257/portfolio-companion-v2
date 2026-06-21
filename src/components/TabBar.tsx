type TabKey = 'portfolio' | 'rsu' | 'signals' | 'watchlist' | 'ask-claude' | 'settings'

interface Tab {
  key: TabKey
  label: string
  icon: string
}

const TABS: Tab[] = [
  { key: 'portfolio', label: 'Portfolio', icon: '💼' },
  { key: 'rsu', label: 'RSU', icon: '📋' },
  { key: 'signals', label: 'Signals', icon: '⚡' },
  { key: 'watchlist', label: 'Watchlist', icon: '👀' },
  { key: 'ask-claude', label: 'Ask Claude', icon: '💬' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
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
            className={`py-3 px-4 font-medium transition-colors relative flex-shrink-0 snap-start ${
              activeTab === tab.key
                ? 'text-white'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <span className="mr-2">{tab.icon}</span>
            {tab.label}
            {activeTab === tab.key && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white" />
            )}
          </button>
        ))}
      </div>
      {/* Subtle gradient hint for more content */}
      <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-gray-950 pointer-events-none" />
    </div>
  )
}
