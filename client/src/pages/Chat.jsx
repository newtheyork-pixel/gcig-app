import { useEffect, useMemo, useRef, useState } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { Send, Hash, Building2, Trash2, Menu, X } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

const POLL_INTERVAL_MS = 3000;

function formatTimestamp(iso) {
  const d = new Date(iso);
  if (isToday(d)) return format(d, 'h:mm a');
  if (isYesterday(d)) return `Yesterday ${format(d, 'h:mm a')}`;
  return format(d, 'MMM d · h:mm a');
}

export default function Chat() {
  const { user, isExecutive } = useAuth();
  const [channels, setChannels] = useState({ general: null, industries: [] });
  const [activeChannel, setActiveChannel] = useState('general');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const lastIdRef = useRef(0);
  const scrollRef = useRef(null);
  const pollingRef = useRef(null);
  const [channelsOpen, setChannelsOpen] = useState(false);

  // Load the channel list once.
  useEffect(() => {
    api.get('/chat/channels').then(({ data }) => setChannels(data));
  }, []);

  // Reset + load messages whenever the active channel changes.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    lastIdRef.current = 0;
    (async () => {
      try {
        const { data } = await api.get('/chat/messages', {
          params: { channel: activeChannel },
        });
        if (cancelled) return;
        setMessages(data);
        lastIdRef.current = data.length > 0 ? data[data.length - 1].id : 0;
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'Failed to load messages');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChannel]);

  // Poll for new messages.
  useEffect(() => {
    clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const { data } = await api.get('/chat/messages', {
          params: { channel: activeChannel, since: lastIdRef.current },
        });
        if (data.length > 0) {
          setMessages((prev) => {
            const existing = new Set(prev.map((m) => m.id));
            const toAdd = data.filter((m) => !existing.has(m.id));
            if (toAdd.length === 0) return prev;
            return [...prev, ...toAdd];
          });
          lastIdRef.current = Math.max(lastIdRef.current, data[data.length - 1].id);
        }
      } catch {
        /* ignore transient errors */
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(pollingRef.current);
  }, [activeChannel]);

  // Auto-scroll to bottom whenever messages change (unless user scrolled up).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function sendMessage(e) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSending(true);
    setError('');
    try {
      const { data } = await api.post('/chat/messages', {
        channel: activeChannel,
        content: trimmed,
      });
      setMessages((prev) =>
        prev.some((m) => m.id === data.id) ? prev : [...prev, data]
      );
      lastIdRef.current = Math.max(lastIdRef.current, data.id);
      setDraft('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  async function deleteMessage(id) {
    if (!confirm('Delete this message?')) return;
    try {
      await api.delete(`/chat/messages/${id}`);
      setMessages((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    }
  }

  const allChannels = useMemo(() => {
    const list = [{ key: 'general', label: 'General', icon: Hash }];
    for (const ind of channels.industries || []) {
      list.push({ key: ind.key, label: ind.label, icon: Building2 });
    }
    return list;
  }, [channels]);

  const activeLabel =
    allChannels.find((c) => c.key === activeChannel)?.label || 'General';

  return (
    <>
      <PageHeader
        kicker="Members Only"
        title="Chat"
        subtitle="Real-time messaging for the whole group and each industry pod."
      />

      <div className="relative flex h-[calc(100vh-180px)] min-h-[420px] overflow-hidden rounded-xl border border-navy-100 bg-white shadow-card md:h-[calc(100vh-220px)] md:min-h-[500px]">
        {/* Channel list — always visible on desktop, slide-in drawer on mobile */}
        <aside
          className={`absolute inset-y-0 left-0 z-20 flex w-64 shrink-0 flex-col border-r border-navy-100 bg-navy-50 transition-transform md:static md:w-56 md:translate-x-0 ${
            channelsOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wider text-navy-400">
            Channels
            <button
              onClick={() => setChannelsOpen(false)}
              className="rounded p-1 text-navy-400 hover:bg-navy-100 md:hidden"
              aria-label="Close channels"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 pb-3">
            {allChannels.map((c) => {
              const Icon = c.icon;
              const active = c.key === activeChannel;
              return (
                <button
                  key={c.key}
                  onClick={() => {
                    setActiveChannel(c.key);
                    setChannelsOpen(false);
                  }}
                  className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition ${
                    active
                      ? 'bg-navy text-white'
                      : 'text-navy hover:bg-navy-100'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{c.label}</span>
                </button>
              );
            })}
            {allChannels.length === 1 && (
              <p className="mt-3 px-3 text-xs text-navy-400">
                You'll see pod channels here when you're assigned to an industry.
              </p>
            )}
          </nav>
        </aside>

        {/* Scrim when the mobile drawer is open */}
        {channelsOpen && (
          <div
            className="absolute inset-0 z-10 bg-navy/40 md:hidden"
            onClick={() => setChannelsOpen(false)}
          />
        )}

        {/* Messages + input */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-navy-100 px-3 py-3 md:px-5">
            <button
              onClick={() => setChannelsOpen(true)}
              className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50 md:hidden"
              aria-label="Open channels"
            >
              <Menu className="h-4 w-4" />
            </button>
            <Hash className="h-4 w-4 text-navy-400" />
            <div className="font-semibold text-navy">{activeLabel}</div>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-3 space-y-3 md:px-5 md:py-4"
          >
            {messages.length === 0 ? (
              <div className="py-12 text-center text-sm text-navy-400">
                No messages yet — say hi 👋
              </div>
            ) : (
              messages.map((m, i) => {
                const prev = messages[i - 1];
                const consecutive =
                  prev &&
                  prev.user.id === m.user.id &&
                  new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60 * 1000;
                const canDelete = m.user.id === user?.id || isExecutive;
                return (
                  <div key={m.id} className={`group flex gap-3 ${consecutive ? 'mt-0.5' : 'mt-3'}`}>
                    {consecutive ? (
                      <div className="w-8 shrink-0" />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy text-xs font-bold text-gold">
                        {m.user.name?.[0]?.toUpperCase() || '?'}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      {!consecutive && (
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-semibold text-navy">
                            {m.user.name}
                          </span>
                          <RoleBadge role={m.user.role} />
                          <span className="text-[10px] text-navy-400">
                            {formatTimestamp(m.createdAt)}
                          </span>
                        </div>
                      )}
                      <div className="flex items-start gap-2">
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-navy">
                          {m.content}
                        </p>
                        {canDelete && (
                          <button
                            onClick={() => deleteMessage(m.id)}
                            className="opacity-0 transition group-hover:opacity-100"
                            title="Delete"
                          >
                            <Trash2 className="h-3 w-3 text-red-500 hover:text-red-700" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <form
            onSubmit={sendMessage}
            className="border-t border-navy-100 px-3 py-3 md:px-5"
          >
            {error && (
              <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage(e);
                  }
                }}
                placeholder={`Message #${activeLabel}…`}
                rows={1}
                maxLength={2000}
                className="flex-1 resize-none rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-navy text-white hover:bg-navy-700 disabled:opacity-50"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-1 text-[10px] text-navy-400">
              Enter to send · Shift+Enter for newline
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
