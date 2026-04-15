interface Tab {
  id: string;
  label: string;
  count?: number;
}

interface Props {
  tabs: Tab[];
  activeTab: string;
  onSelect: (id: string) => void;
}

export function DetailTabs({ tabs, activeTab, onSelect }: Props) {
  return (
    <div className="flex border-b border-gray-200 px-4 gap-0">
      {tabs.map(tab => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            className={`px-3 py-2 text-[11px] font-medium border-b-2 transition-colors ${
              active
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-400 hover:text-gray-600 hover:border-gray-300'
            }`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={`ml-1.5 text-[10px] ${active ? 'text-indigo-400' : 'text-gray-300'}`}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
