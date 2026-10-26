import { ChartColumn, Database, FileSpreadsheet, LayoutDashboard, Paintbrush, Sparkles, Table2, Users } from 'lucide-react'
import { useT } from '../lib/i18n'
import { Logo } from './Logo'

const insert = (text: string) => window.dispatchEvent(new CustomEvent('lovbase:insert', { detail: { text } }))

export function ChatSuggestions() {
  const t = useT()
  const groups = [
    {
      title: t('chat.suggestions.create', 'Create or modify an app'),
      items: [
        { icon: Users, text: t('chat.suggestions.crm', 'Help me build a CRM for customers and follow-ups') },
        { icon: Table2, text: t('chat.suggestions.inventory', 'Create an inventory app for products and stock movements') },
        { icon: Paintbrush, text: t('chat.suggestions.design', 'Give my app a clean, modern interface') },
      ],
    },
    {
      title: t('chat.suggestions.data', 'Manage and explore data'),
      items: [
        { icon: Database, text: t('chat.suggestions.fields', 'Add a customer status field and link contacts to customers') },
        { icon: ChartColumn, text: t('chat.suggestions.report', 'Analyze monthly sales and show the trends in a chart') },
      ],
    },
    {
      title: t('chat.suggestions.build', 'Build from your data'),
      items: [
        { icon: FileSpreadsheet, text: t('chat.suggestions.csv', 'Turn my CSV into a data management app') },
        { icon: LayoutDashboard, text: t('chat.suggestions.dashboard', 'Build a dashboard from my Google Sheets data') },
      ],
    },
  ]
  return (
    <section className="mx-auto my-auto w-full max-w-md shrink-0 py-4" aria-labelledby="chat-suggestions-title">
      <div className="mb-6 flex items-center justify-center gap-3">
        <Logo size={32} />
        <h2 id="chat-suggestions-title" className="font-display text-xl font-semibold tracking-tight text-fg">
          {t('chat.empty.title', 'How can I help you?')}
        </h2>
      </div>
      <div className="space-y-4">
        {groups.map(group => (
          <div key={group.title}>
            <h3 className="mb-1.5 px-2 text-xs font-medium text-fg-dim">{group.title}</h3>
            <div className="space-y-0.5">
              {group.items.map(({ icon: Icon, text }) => (
                <button key={text} type="button" onClick={() => insert(text)}
                  className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-left text-[13.5px] leading-5 text-fg transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-dim" strokeWidth={1.75} />
                  <span>{text}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button type="button"
        onClick={() => insert(t('chat.suggestions.capabilitiesPrompt', 'What can Lovbase help me build? Introduce its app creation, database editing, data analysis, CSV import, and Google Sheets capabilities, with examples.'))}
        className="mt-5 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-edge bg-panel px-3 py-2.5 text-[13px] font-medium text-fg-mid transition-colors hover:bg-panel-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <Sparkles aria-hidden="true" className="size-4" />
        {t('chat.suggestions.capabilities', 'What can Lovbase do?')}
      </button>
    </section>
  )
}
