import { useState } from 'react';

interface Msg {
  role: 'user' | 'agent';
  text: string;
}

export function AgentChatPanel() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setMessages(m => [
      ...m,
      { role: 'user', text },
      { role: 'agent', text: '(agent backend not wired yet — your message was recorded but no query was executed)' },
    ]);
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-cream-100">
      <div className="px-3 py-2 border-b border-cream-200">
        <div className="text-[11px] uppercase tracking-widest text-roast-light">Agent</div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {messages.length === 0 && (
          <div className="text-roast-medium text-sm">
            Ask the agent to query the graph. Backend wiring lands in a later iteration.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              'rounded-lg p-2 text-sm animate-fade-up ' +
              (m.role === 'user'
                ? 'bg-roast-dark text-cream-50'
                : 'bg-cream-50 border border-cream-200 text-roast-medium italic')
            }
          >
            {m.text}
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex gap-1 p-3 border-t border-cream-200">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Ask something…"
          className="flex-1 bg-cream-50 border border-cream-200 rounded px-2 py-1.5 text-sm text-roast-dark placeholder:text-roast-light focus:outline-none focus:ring-2 focus:ring-roast-light"
        />
        <button
          type="submit"
          className="px-3 py-1.5 bg-roast-dark text-cream-50 rounded text-sm hover:bg-roast-medium"
        >
          Send
        </button>
      </form>
    </div>
  );
}
