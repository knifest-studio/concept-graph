import React, { useEffect, useRef, useState } from 'react';
import { t } from './i18n.mjs';
import './analytics.css';

const date = value => new Date(value).toLocaleString();
const duration = value => `${Math.round((value || 0) / 1000)} s`;
function Table({ columns, rows }) {
  return <div className="analytics-table"><table><thead><tr>{columns.map(([key, title]) => <th key={key} scope="col">{t(title)}</th>)}</tr></thead>
    <tbody>{rows.map((row, i) => <tr key={i}>{columns.map(([key]) => <td key={key}>{row[key] ?? '—'}</td>)}</tr>)}</tbody></table>{!rows.length && <p>{t('No data yet.')}</p>}</div>;
}
function Heatmap({ points }) {
  const [route, setRoute] = useState('board'), [viewport, setViewport] = useState('all');
  const routes = [...new Set(['board', 'boards', ...points.map(point => point.route).filter(Boolean)])];
  const shown = points.filter(point => point.route === route && (viewport === 'all' || point.viewport === viewport));
  return <section><h2>{t('Click heatmap')}</h2><div className="analytics-filters"><label>{t('Route')} <select value={route} onChange={event => setRoute(event.target.value)}>{routes.map(route => <option key={route}>{route}</option>)}</select></label>
    <label>{t('Viewport')} <select value={viewport} onChange={event => setViewport(event.target.value)}>{[['all','All sizes'],['small','Small (<768 px)'],['medium','Medium (768–1279 px)'],['large','Large (1280+ px)']].map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label></div>
    <p>{t('Normalized click positions on a blank page frame; brighter dots mean more clicks.')}</p>
    <div className="analytics-heatmap" role="img" aria-label={t('Click heatmap')}><svg viewBox="0 0 1000 625">{shown.map((point, i) => <circle key={i} cx={point.x * 1000} cy={point.y * 625} r={4 + Math.min(18, Math.sqrt(point.count) * 2)} fill="#ef7954" opacity={Math.min(.85, .2 + Math.log1p(point.count) / 6)}><title>{point.count}</title></circle>)}</svg></div>
  </section>;
}
function Session({ id, services, onClose }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [status, setStatus] = useState('');
  const section = useRef(null);
  useEffect(() => { section.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, []);
  const root = useRef(null), player = useRef(null), controller = useRef(null);
  useEffect(() => {
    let active = true;
    services.api(`/api/analytics/sessions/${id}`).then(value => { if (active) setData(value); }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; controller.current?.abort(); player.current?.pause(); player.current?.$destroy(); };
  }, [id]);
  const more = async () => {
    setLoading(true);
    try { const next = await services.api(`/api/analytics/sessions/${id}?after=${data.events.at(-1).seq}`); setData(current => ({ ...current, events: [...current.events, ...next.events] })); }
    catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  };
  const play = async () => {
    setLoading(true); setError(''); controller.current = new AbortController();
    try {
      const [{ default: Player }] = await Promise.all([import('rrweb-player'), import('rrweb-player/dist/style.css')]);
      const chunks = data.chunks, decoder = new TextDecoder(), events = []; let tail = '', expected = 0;
      for (const chunk of chunks) {
        if (chunk.seq !== expected++) { setStatus(t('Recording is incomplete: an upload was lost.')); break; }
        const response = await fetch(`/api/analytics/sessions/${id}/${chunk.seq}`, { credentials: 'same-origin', signal: controller.current.signal });
        if (!response.ok) throw new Error(t('Could not load recording.'));
        const text = tail + decoder.decode(await response.arrayBuffer(), { stream: true }), lines = text.split('\n'); tail = lines.pop();
        for (const line of lines) if (line) events.push(JSON.parse(line));
      }
      if (tail) setStatus(t('Recording is incomplete: an upload was lost.'));
      if (events.length < 2 || !events.some(event => event.type === 2)) throw new Error(t('Recording has no complete snapshot.'));
      if (controller.current.signal.aborted) return;
      player.current?.pause(); player.current?.$destroy(); root.current.replaceChildren();
      player.current = new Player({ target: root.current, props: { events, width: Math.max(320, Math.min(1024, root.current.clientWidth)), height: 576, autoPlay: false, UNSAFE_replayCanvas: false, mouseTail: false } });
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); }
    finally { setLoading(false); }
  };
  return <section className="analytics-session" ref={section}><button type="button" onClick={onClose}>{t('Close session')}</button><h2>{t('Session details')}</h2>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {data && <><p>{data.session?.user} · {date(data.session?.started)} · {duration(data.session?.duration)}</p>
      <button type="button" disabled={loading || !data.chunks.length} onClick={play}>{t(loading ? 'Loading…' : 'Load recording')}</button>
      <div ref={root} className="analytics-player"/>
      <h3>{t('Event timeline')}</h3><Table columns={[["time","Time"],["kind","Kind"],["name","Event"],["area","Area"],["board","Board"],["details","Details"]]} rows={data.events.map(event => ({ ...event, time: <button type="button" onClick={() => player.current?.goto(Math.max(0, event.time - player.current.getMetaData().startTime), false)}>{date(event.time)}</button> }))}/>
      {data.events.length > 0 && data.events.length % 1000 === 0 && <button type="button" disabled={loading} onClick={more}>{t('Load more events')}</button>}</>}
  </section>;
}
export default function AnalyticsAdmin({ services }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [days, setDays] = useState(30), [selected, setSelected] = useState(null), [refresh, setRefresh] = useState(0), [least, setLeast] = useState(false), [area, setArea] = useState('');
  useEffect(() => {
    let active = true; setError('');
    services.api(`/api/analytics/overview?days=${days}`).then(value => { if (active) setData(value); }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [days, refresh]);
  return <main className="analytics-admin" data-analytics-area="analytics-admin"><header><a href="/">{t('All boards')}</a><h1>{t('Product analytics')}</h1><label>{t('Days')} <select value={days} onChange={event => { setDays(Number(event.target.value)); setData(null); }}>{[7,30,90,180].map(value => <option key={value}>{value}</option>)}</select></label><button type="button" onClick={() => setRefresh(value => value + 1)}>{t('Refresh')}</button></header>
    {error && <p role="alert">{error}</p>}{!data && !error && <p>{t('Loading…')}</p>}
    {data && <><section><h2>{t('Overview')}</h2><div className="analytics-totals">{[['sessions','Sessions'],['users','Active users'],['events','Events']].map(([key, label]) => <div key={key}><strong>{data.totals[key]}</strong><span>{t(label)}</span></div>)}</div>
      <Table columns={[["day","Day"],["sessions","Sessions"],["users","Active users"],["events","Events"]]} rows={data.daily}/></section>
      <section><h2>{t('Controls')}</h2><div className="analytics-filters"><label>{t('Area')} <select value={area} onChange={event => setArea(event.target.value)}><option value="">{t('All areas')}</option>{[...new Set(data.controls.map(row => row.area))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
        <label>{t('Order')} <select value={least ? 'least' : 'most'} onChange={event => setLeast(event.target.value === 'least')}><option value="most">{t('Most used')}</option><option value="least">{t('Least used')}</option></select></label></div>
        <p>{t('Most and least used 50 observed controls per area. Shortcut combinations appear in session details.')}</p><Table columns={[["area","Area"],["name","Control"],["clicks","Clicks / changes"],["shortcuts","Shortcuts"],["users","Unique users"]]} rows={data.controls.filter(row => !area || row.area === area).sort((a,b) => (least ? 1 : -1) * (a.clicks + a.shortcuts - b.clicks - b.shortcuts))}/></section>
      <section><h2>{t('Rage clicks')}</h2><Table columns={[["area","Area"],["name","Control"],["count","Count"],["users","Unique users"]]} rows={data.rage}/></section>
      <section><h2>{t('Errors')}</h2><Table columns={[["message","Message"],["count","Count"],["users","Unique users"]]} rows={data.errors}/></section>
      <section><h2>{t('Generations')}</h2><Table columns={[["generator","Generator"],["started","Started"],["finished","Finished"],["failed","Failed"],["duration","Average duration"]]} rows={data.generations.map(row => ({ ...row, duration: duration(row.duration) }))}/></section>
      <Heatmap points={data.heatmap}/>
      <section><h2>{t('Recent sessions')}</h2><p>{t('Newest 100 sessions in the selected period.')}</p><Table columns={[["user","User"],["started","Started"],["duration","Duration"],["active","Active time"],["event_count","Events"],["recording","Recording"],["open","Details"]]} rows={data.sessions.map(row => ({ ...row, started: date(row.started), duration: duration(row.duration || row.last_seen - row.started), active: duration(row.active), recording: row.replay_chunks ? t('Available') : '—', open: <button type="button" onClick={() => setSelected(row.id)}>{t('Open session')}</button> }))}/></section>
      {selected && <Session key={selected} id={selected} services={services} onClose={() => setSelected(null)}/>}</>}
  </main>;
}
