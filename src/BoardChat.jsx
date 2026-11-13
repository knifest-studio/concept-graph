import { track } from './analytics.mjs';
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from './i18n.mjs';
import { Avatar } from './BoardPresence.jsx';
import { chatLinks } from './board-chat.mjs';

export function ChatButton({ session, open, onClick, button }) {
  const state = useSyncExternalStore(session.chatStore.subscribe, session.chatStore.get);
  return <button ref={button} type="button" className="cloud-history-button chat-button" aria-expanded={open} aria-controls="board-chat" onClick={onClick}>
    {t('Chat')}{state.unread > 0 && <b className="chat-badge" aria-label={t('{count} unread messages', { count: state.unread })}>{state.unread > 99 ? '99+' : state.unread}</b>}
  </button>;
}
const nodeTitle = node => (node.data.title || node.data.caption || node.data.text || (node.type === 'image' ? t('Image') : t('Node'))).slice(0, 64);
const LinkedText = ({ text }) => chatLinks(text).map((part, index) => part.url ? <a key={index} href={part.url} target="_blank" rel="noopener noreferrer">{part.text}</a> : part.text);

export function BoardChatPanel({ session, onClose }) {
  const chat = session.chat, state = useSyncExternalStore(session.chatStore.subscribe, session.chatStore.get);
  const selected = useSyncExternalStore(session.chatSelection.subscribe, session.chatSelection.get);
  const [graph, setGraph] = useState(() => session.read()), [text, setText] = useState(''), [attached, setAttached] = useState(null);
  const scroll = useRef(null), input = useRef(null), atBottom = useRef(true), earlier = useRef(null);
  useEffect(() => {
    input.current?.focus(); chat.visible(true, true);
    const visibility = () => chat.visible(true, atBottom.current);
    document.addEventListener('visibilitychange', visibility);
    let frame = 0;
    const changed = transaction => { if (transaction.changed.size && !frame) frame = requestAnimationFrame(() => { frame = 0; setGraph(session.read()); }); };
    session.doc.on('afterTransaction', changed);
    return () => { cancelAnimationFrame(frame); session.doc.off('afterTransaction', changed); document.removeEventListener('visibilitychange', visibility); chat.visible(false); };
  }, [session]);
  useLayoutEffect(() => {
    const element = scroll.current; if (!element) return;
    if (earlier.current && !state.loading) { element.scrollTop += element.scrollHeight - earlier.current.height; earlier.current = null; }
    else if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [state.messages, state.pending, state.loading]);
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), selection = selected.map(id => nodes.get(id)).find(Boolean);
  const submit = event => { event?.preventDefault(); if (!text.trim() || !state.online || text.trim().length > 2000) return; chat.post(text, attached); track('chat_message_sent'); setText(''); setAttached(null); };
  const chip = id => <button type="button" className="chat-node-chip" disabled={!nodes.has(id)} onClick={() => session.goToNode?.(id)}>{nodes.has(id) ? nodeTitle(nodes.get(id)) : t('Node was deleted')}</button>;
  return <aside id="board-chat" className="board-chat-panel" data-analytics-area="chat" data-analytics-panel="Chat" aria-label={t('Board chat')} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} onKeyUp={event => event.stopPropagation()} onPaste={event => event.stopPropagation()} onCopy={event => event.stopPropagation()}>
    <header><strong>{t('Board chat')}</strong><button type="button" aria-label={t('Close chat')} onClick={onClose}>×</button></header>
    <div className="chat-messages" ref={scroll} onScroll={event => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; chat.visible(true, atBottom.current); }}>
      {state.more && <button type="button" className="chat-earlier" disabled={state.loading} onClick={() => { earlier.current = { height: scroll.current.scrollHeight }; session.chat.request(state.messages[0]?.id); }}>{state.loading ? t('Loading…') : t('Load earlier')}</button>}
      {!state.messages.length && <p className="chat-empty">{state.loading ? t('Loading…') : t('Start a conversation with your teammates.')}</p>}
      <ol aria-label={t('Messages')}>
        {state.messages.map((message, index) => {
          const previous = state.messages[index - 1], grouped = previous && previous.author.email === message.author.email && previous.agent === message.agent && Date.parse(message.time) - Date.parse(previous.time) < 300000;
          return <li key={message.id} className={grouped ? 'chat-grouped' : ''}>
            {!grouped && <div className="chat-author"><Avatar user={message.author}/><b>{message.author.name}</b>{message.agent && <small>{t('via agent')}</small>}</div>}
            <div className="chat-message-body">{message.deleted ? <em>{t('Message deleted')}</em> : <><p><LinkedText text={message.text}/></p>{message.nodeId && chip(message.nodeId)}</>}
              <footer><time dateTime={message.time} title={new Date(message.time).toLocaleString()}>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                {!message.deleted && (message.author.email === chat.email || session.role === 'owner') && <button type="button" aria-label={t('Delete message')} onClick={() => chat.sendWire({ type: 'chat-delete', id: message.id })}>{t('Delete')}</button>}</footer>
            </div>
          </li>;
        })}
        {state.pending.map(message => <li className="chat-pending" key={message.key}><p>{message.text}</p><small>{message.error ? t(message.error) : t('Sending…')}</small>{message.error && <button type="button" disabled={!state.online} onClick={() => chat.retry(message.key)}>{t('Retry')}</button>}</li>)}
      </ol>
    </div>
    {state.error && <p className="chat-error" role="alert">{t(state.error)}{!state.loading && <button type="button" onClick={() => chat.request()}>{t('Retry')}</button>}</p>}
    <form className="chat-composer" onSubmit={submit}>
      {attached ? <div className="chat-attachment">{chip(attached)}<button type="button" aria-label={t('Remove node link')} onClick={() => setAttached(null)}>×</button></div>
        : selection && <button type="button" className="chat-attach" onClick={() => setAttached(selection.id)}>{t('Attach selected node')}: {nodeTitle(selection)}</button>}
      <textarea ref={input} aria-label={t('Message')} placeholder={t('Write a message…')} maxLength={2000} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}/>
      <div><small>{state.online ? t('Enter to send · Shift+Enter for a new line') : t('Chat is reconnecting…')}</small><button type="submit" disabled={!state.online || !text.trim()}>{t('Send')}</button></div>
    </form>
  </aside>;
}
