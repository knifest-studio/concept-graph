import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, createContext, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, Background, Handle, Position, applyNodeChanges, applyEdgeChanges, addEdge, useReactFlow, useStore, useUpdateNodeInternals } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import { runTiming } from '../timing.mjs';
import { ButtonHelp } from './ButtonHelp.jsx';
import { nodeClipboardType, selectedGraph, readNodeClipboard, cloneSelection } from './clipboard.mjs';
import { connectionColor, edgeDropCreatesPrompt, cleanGroups, pruneGroups, canvasView, moveGroup, alignNodes } from './canvas.mjs';

const Actions = createContext(null);
const id = () => crypto.randomUUID();
const busy = run => ['running', 'queued'].includes(run?.status);

function Icon({ name, size = 18 }) {
  const paths = {
    group: <><rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 3"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/></>,
    align: <><rect x="2" y="9" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M8 12h4m4-7h-4v14h4"/></>,
    chevron: <path d="m8 5 7 7-7 7"/>, ungroup: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="m9 9 6 6m0-6-6 6"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 16 5-5 4 4 4-6 5 8"/></>,
    text: <><path d="M4 5h16M12 5v14M8 19h8"/></>, play: <path d="m8 5 11 7-11 7z"/>, arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    expand: <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>, download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, undo: <path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12"/>, redo: <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>,
    minus: <path d="M5 12h14"/>, check: <path d="m5 12 4 4L19 6"/>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>, branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-10c0 7-12 1-12 8"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.plus}</svg>;
}

function TextNode({ id, data }) {
  const actions = useContext(Actions);
  const run = [...actions.runs].reverse().find(r => r.nodeId === id);
  const pending = busy(run) || actions.starting === id;
  const timing = runTiming(actions.starting === id && !busy(run) ? null : run, actions.runs, actions.now);
  const [draft, setDraft] = useState(data.text);
  const editor = useRef(null);
  // React Flow propagates node data through its store after the input event.
  // Keep the controlled input synchronous so React never restores an old value/caret.
  useLayoutEffect(() => {
    if (document.activeElement !== editor.current) setDraft(data.text);
  }, [data.text]);
  useLayoutEffect(() => {
    const input = editor.current;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);
  useEffect(() => {
    if (actions.focusId === id) {
      // Wait until the release event finishes focusing the source node.
      const timer = setTimeout(() => {
        editor.current?.focus({ preventScroll: true });
        actions.clearFocus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [actions.focusId, id]);
  return <article className={`node-card text-node ${pending ? 'working' : ''}`}>
    <Handle type="target" position={Position.Left} aria-label="Connect input to prompt"/>
    <header className="node-drag"><button className={`run-button nodrag ${pending ? 'running' : ''}`} aria-label={pending ? 'Cancel generation' : 'Run prompt'} onClick={() => pending && run ? actions.cancel(run.id) : actions.run(id)} disabled={actions.starting === id || (!pending && !draft.trim())} data-tooltip={pending ? "Cancel generation" : draft.trim() ? "Generate images · ⌘ Enter" : "Write a prompt first"}>{pending ? timing.label : <Icon name="play" size={16}/>}</button></header>
    <textarea ref={editor} className="nodrag" rows={1} aria-label="Image prompt" value={draft} placeholder="Describe an idea…" onFocus={actions.checkpoint} onChange={event => { const value = event.target.value; setDraft(value); actions.editText(id, value); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!pending) actions.run(id); } }}/>
    {run?.status === 'error' && <div className="node-error nodrag">{run.error}</div>}
    <Handle type="source" position={Position.Right} aria-label="Connect prompt to another node"/>
  </article>;
}

function ImageNode({ id, data }) {
  const actions = useContext(Actions);
  const zoom = useStore(state => state.transform[2]);
  return <article className="node-card image-node" onDoubleClick={() => actions.view(id)}>
    {data.runId && <Handle type="target" position={Position.Left} isConnectable={false}/>}
    <img className="image-content" src={`/assets/${data.asset}`} alt={data.label || 'Concept image'} draggable="false"/>
    <div className="image-shade"/>
    <button className="image-expand nodrag" style={{ '--inverse-zoom': 1 / zoom }} data-tooltip="View fullscreen" aria-label="Open image fullscreen" onClick={() => actions.view(id)}><Icon name="expand" size={24}/></button>
    <Handle type="source" position={Position.Right} aria-label="Connect image as reference"/>
  </article>;
}

function GroupNode({ id, data }) {
  const actions = useContext(Actions);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, data.collapsed, updateNodeInternals]);
  return <article className={`group-frame ${data.collapsed ? 'collapsed' : ''}`}>
    <header><button className={`group-toggle nodrag ${data.collapsed ? '' : 'expanded'}`} aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.name}`} data-tooltip={data.collapsed ? 'Expand group' : 'Collapse group'} onClick={() => actions.toggleGroup(id)}><Icon name="chevron" size={16}/></button><strong>{data.name}</strong><span>{data.count} nodes</span><button className="icon-button nodrag" aria-label={`Ungroup ${data.name}`} data-tooltip="Ungroup; keep nodes" onClick={() => actions.ungroup(id)}><Icon name="ungroup" size={16}/></button></header>
    {data.collapsed && <><Handle type="target" position={Position.Left} isConnectable={false}/><Handle type="source" position={Position.Right} isConnectable={false}/></>}
  </article>;
}
const nodeTypes = { text: TextNode, image: ImageNode, group: GroupNode };
const cleanNodes = nodes => nodes.map(({ id, type, position, data }) => ({ id, type, position, data }));
const cleanEdges = edges => edges.map(({ id, source, target }) => ({ id, source, target }));
const capture = (nodes, edges, groups) => JSON.stringify({ nodes: cleanNodes(nodes), edges: cleanEdges(edges), groups: cleanGroups(groups), capturedAt: new Date().toISOString() });

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || 'Request failed.'), { status: response.status, value });
  return value;
}
const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function App({ boardId, boards, updateBoards, selectBoard, theme, toggleTheme }) {
  const [nodes, setNodes] = useState([]), [edges, setEdges] = useState([]), [runs, setRuns] = useState([]);
  const [groups, setGroups] = useState([]), [focusId, setFocusId] = useState(null);
  const groupRef = useRef([]);
  const [status, setStatus] = useState({}), [saved, setSaved] = useState('Loading…'), [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState(''), [viewId, setViewId] = useState(null), [starting, setStarting] = useState(null);
  const [tab, setTab] = useState('canvas');
  const [switching, setSwitching] = useState(false), [uploading, setUploading] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const boardFileInput = useRef(null);
  const [boardForm, setBoardForm] = useState(null), [nameDraft, setNameDraft] = useState('');
  const switchingRef = useRef(false), uploads = useRef(0);
  const boardPath = `/api/boards/${boardId}`;
  const currentBoard = boards.find(board => board.id === boardId);
  const [connectionType, setConnectionType] = useState('text');
  const [now, setNow] = useState(Date.now);
  const hasActiveRuns = runs.some(busy);
  useEffect(() => {
    if (!hasActiveRuns) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveRuns]);
  const modalOpen = useRef(false);
  modalOpen.current = !!viewId || !!boardForm || switching || !!transfer;
  const flow = useReactFlow();
  const nodeRef = useRef([]), edgeRef = useRef([]), base = useRef({ revision: 0, nodes: [], edges: [] });
  const dirty = useRef(false), version = useRef(0), saving = useRef(null), saveTimer = useRef(null), viewport = useRef({ x: 0, y: 0, zoom: 1 });
  const history = useRef([]), future = useRef([]), lastHistory = useRef('');
  const mouse = useRef({ x: innerWidth / 2, y: innerHeight / 2 }), fileInput = useRef(null), toastTimer = useRef(null);
  const saveFn = useRef(null);
  const notify = useCallback(message => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 6500); }, []);
  const putNodes = value => { nodeRef.current = typeof value === 'function' ? value(nodeRef.current) : value; setNodes(nodeRef.current); };
  const putEdges = value => { edgeRef.current = typeof value === 'function' ? value(edgeRef.current) : value; setEdges(edgeRef.current); };
  const putGroups = value => { groupRef.current = typeof value === 'function' ? value(groupRef.current) : value; setGroups(groupRef.current); };
  const markDirty = () => {
    dirty.current = true; version.current++; setSaved('Saving…');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveFn.current().catch(error => { setSaved('Save failed'); notify(error.message); }), 500);
  };
  const checkpoint = () => {
    const signature = JSON.stringify({ nodes: cleanNodes(nodeRef.current), edges: cleanEdges(edgeRef.current), groups: cleanGroups(groupRef.current) });
    if (signature !== lastHistory.current) { history.current.push(capture(nodeRef.current, edgeRef.current, groupRef.current)); history.current = history.current.slice(-50); lastHistory.current = signature; future.current = []; }
  };
  const mergeRemote = remote => {
    if (remote.revision <= base.current.revision) return;
    const knownNodes = new Set(base.current.nodes.map(n => n.id)), knownEdges = new Set(base.current.edges.map(e => e.id));
    const localIds = new Set(nodeRef.current.map(n => n.id));
    const newNodes = remote.nodes.filter(n => !knownNodes.has(n.id) && !localIds.has(n.id));
    const allIds = new Set([...localIds, ...newNodes.map(n => n.id)]);
    const localEdgeIds = new Set(edgeRef.current.map(e => e.id));
    const newEdges = remote.edges.filter(e => !knownEdges.has(e.id) && !localEdgeIds.has(e.id) && allIds.has(e.source) && allIds.has(e.target));
    putNodes([...nodeRef.current, ...newNodes]); putEdges([...edgeRef.current, ...newEdges]);
    base.current = remote;
    if (newNodes.length) notify(`${newNodes.length} new image${newNodes.length === 1 ? '' : 's'} added to your canvas`);
  };
  const saveNow = async () => {
    clearTimeout(saveTimer.current);
    if (saving.current) { await saving.current; if (dirty.current) return saveNow(); return; }
    if (!dirty.current) return;
    const save = async () => {
      for (let attempt = 0; attempt < 8 && dirty.current; attempt++) {
        const editVersion = version.current;
        const payload = { revision: base.current.revision, nodes: cleanNodes(nodeRef.current), edges: cleanEdges(edgeRef.current), groups: cleanGroups(groupRef.current), viewport: viewport.current };
        try {
          const result = await api(boardPath + '/graph', jsonOptions('PUT', payload));
          if (result.revision >= base.current.revision) base.current = { ...payload, revision: result.revision };
          if (editVersion === version.current) dirty.current = false;
          setSaved(dirty.current ? 'Saving…' : 'All changes saved');
        } catch (error) {
          if (error.status !== 409) throw error;
          mergeRemote(error.value.graph);
        }
      }
      if (dirty.current) throw new Error('Canvas is changing too quickly to save. Try again in a moment.');
    };
    saving.current = save();
    try { await saving.current; } finally { saving.current = null; }
  };
  saveFn.current = saveNow;

  useEffect(() => {
    let events, disposed = false;
    api(boardPath).then(({ board: { graph }, status }) => {
      if (disposed) return;
      base.current = graph; putNodes(graph.nodes); putEdges(graph.edges); putGroups(graph.groups || []); setRuns(graph.runs); setStatus(status);
      viewport.current = graph.viewport; flow.setViewport(graph.viewport);
      setLoaded(true); setSaved('All changes saved');
      events = new EventSource(boardPath + '/events');
      events.addEventListener('boards', event => updateBoards(JSON.parse(event.data).boards));
      events.addEventListener('status', event => setStatus(JSON.parse(event.data)));
      events.addEventListener('graph', event => { const graph = JSON.parse(event.data); mergeRemote(graph); setRuns(graph.runs); });
      events.addEventListener('run', event => {
        const run = JSON.parse(event.data);
        setRuns(current => { const old = current.find(r => r.id === run.id); return old ? current.map(r => r.id === run.id ? { ...r, ...run } : r) : [...current, run]; });
      });
      events.onerror = () => setStatus(current => ({ ...current, connected: false }));
    }).catch(error => { setSaved('Could not load'); notify(error.message); });
    return () => { disposed = true; events?.close(); clearTimeout(saveTimer.current); clearTimeout(toastTimer.current); };
  }, []);

  const addText = (position, text = '') => {
    checkpoint();
    const node = { id: id(), type: 'text', position: position || flow.screenToFlowPosition({ x: innerWidth * .52, y: innerHeight * .36 }), data: { text } };
    putNodes(current => [...current.map(n => ({ ...n, selected: false })), { ...node, selected: true }]); markDirty();
    return node;
  };
  const addImages = async (files, position) => {
    checkpoint(); uploads.current++; setUploading(true);
    try { for (const [index, file] of [...files].entries()) {
      try {
        const { asset } = await api('/api/assets', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        const start = position || flow.screenToFlowPosition({ x: innerWidth * .5, y: innerHeight * .3 });
        putNodes(current => [...current, { id: id(), type: 'image', position: { x: start.x + index * 35, y: start.y + index * 35 }, data: { asset, label: file.name || 'Pasted image' } }]); markDirty();
      } catch (error) { notify(error.message); }
    } } finally { uploads.current--; setUploading(uploads.current > 0); }
  };
  const insertSelection = (selection, position) => {
    if (!selection.nodes.length) return;
    const copied = cloneSelection(selection, position);
    checkpoint();
    putNodes(current => [...current.map(node => ({ ...node, selected: false })), ...copied.nodes]);
    putEdges(current => [...current.map(edge => ({ ...edge, selected: false })), ...copied.edges]);
    putGroups(current => current.map(group => ({ ...group, selected: false })));
    markDirty();
  };
  const removeSelected = () => {
    checkpoint(); const removed = new Set(nodeRef.current.filter(n => n.selected).map(n => n.id));
    putNodes(current => current.filter(n => !removed.has(n.id)));
    putEdges(current => current.filter(e => !e.selected && !removed.has(e.source) && !removed.has(e.target)));
    putGroups(pruneGroups(groupRef.current.filter(group => !group.selected), nodeRef.current)); markDirty();
  };
  const undo = (redo = false) => {
    const from = redo ? future.current : history.current, to = redo ? history.current : future.current;
    if (!from.length) return;
    to.push(capture(nodeRef.current, edgeRef.current, groupRef.current));
    const snapshot = from.pop(); lastHistory.current = snapshot;
    const graph = JSON.parse(snapshot);
    const freshOutputs = nodeRef.current.filter(n => n.type === 'image' && n.data.runId && n.data.createdAt > graph.capturedAt && !graph.nodes.some(old => old.id === n.id));
    const ids = new Set([...graph.nodes, ...freshOutputs].map(n => n.id));
    const freshEdges = edgeRef.current.filter(e => freshOutputs.some(n => n.id === e.target) && ids.has(e.source) && !graph.edges.some(old => old.id === e.id));
    putNodes([...graph.nodes, ...freshOutputs]); putEdges([...graph.edges, ...freshEdges]); putGroups(pruneGroups(graph.groups || [], nodeRef.current)); markDirty();
  };

  const groupSelected = () => {
    const members = nodeRef.current.filter(node => node.selected);
    if (members.length < 2 || groupRef.current.some(group => group.selected || group.nodeIds.some(id => members.some(node => node.id === id)))) return;
    checkpoint();
    const usedNames = new Set(groupRef.current.map(group => group.name));
    let number = 1; while (usedNames.has(`Group ${number}`)) number++;
    putGroups(current => [...current.map(group => ({ ...group, selected: false })), { id: id(), name: `Group ${number}`, nodeIds: members.map(node => node.id), collapsed: false, selected: true }]);
    putNodes(current => current.map(node => ({ ...node, selected: false }))); markDirty();
  };
  const toggleGroup = groupId => {
    checkpoint();
    const group = groupRef.current.find(group => group.id === groupId);
    putNodes(current => current.map(node => group.nodeIds.includes(node.id) ? { ...node, selected: false } : node));
    putGroups(current => current.map(group => group.id === groupId ? { ...group, collapsed: !group.collapsed } : group)); markDirty();
  };
  const ungroup = groupId => { checkpoint(); putGroups(current => current.filter(group => group.id !== groupId)); markDirty(); };
  const autoAlign = () => {
    checkpoint(); putNodes(alignNodes(nodeRef.current, edgeRef.current, groupRef.current)); markDirty();
    requestAnimationFrame(() => flow.fitView({ duration: 300, padding: .18, maxZoom: 1 }));
  };
  const nodesChanged = changes => {
    const groupIds = new Set(groupRef.current.map(group => group.id)), moved = new Set();
    let next = nodeRef.current;
    for (const change of changes.filter(change => groupIds.has(change.id))) {
      if (change.type === 'select') putGroups(current => current.map(group => group.id === change.id ? { ...group, selected: change.selected } : group));
      if (change.type === 'position' && change.position) {
        const group = groupRef.current.find(group => group.id === change.id);
        next = moveGroup(next, group, change.position); group.nodeIds.forEach(id => moved.add(id));
      }
    }
    putNodes(applyNodeChanges(changes.filter(change => !groupIds.has(change.id) && !(change.type === 'position' && moved.has(change.id))), next));
    if (changes.some(change => change.type === 'remove')) putGroups(pruneGroups(groupRef.current, nodeRef.current));
    if (changes.some(change => change.type === 'position' || change.type === 'remove')) markDirty();
  };

  useEffect(() => {
    if (!loaded) return;
    const paste = async event => {
      if (modalOpen.current) return;
      const files = [...event.clipboardData.items].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); addImages(files, flow.screenToFlowPosition(mouse.current)); return; }
      if (event.target.closest('textarea,input,[contenteditable="true"]')) return;
      const selection = readNodeClipboard(event.clipboardData.getData(nodeClipboardType) || event.clipboardData.getData('text/plain'));
      if (selection) {
        event.preventDefault();
        const position = flow.screenToFlowPosition(mouse.current);
        const assets = [...new Set(selection.nodes.filter(node => node.type === 'image').map(node => node.data.asset))];
        uploads.current++; setUploading(true);
        try {
          await Promise.all(assets.map(async asset => {
            if (!(await fetch(`/assets/${asset}`, { method: 'HEAD' })).ok) throw new Error('A copied image is unavailable in this app installation.');
          }));
          insertSelection(selection, position);
        } catch (error) { notify(error.message); }
        finally { uploads.current--; setUploading(uploads.current > 0); }
        return;
      }
      const text = event.clipboardData.getData('text/plain');
      if (text.trim()) { event.preventDefault(); addText(flow.screenToFlowPosition(mouse.current), text); }
    };
    const copy = event => {
      if (modalOpen.current || event.target.closest('textarea,input,[contenteditable="true"]')) return;
      const selection = selectedGraph(nodeRef.current, edgeRef.current);
      if (!selection.nodes.length) return;
      event.preventDefault();
      const text = JSON.stringify(selection);
      event.clipboardData.setData(nodeClipboardType, text);
      event.clipboardData.setData('text/plain', text);
    };
    const key = event => {
      if (event.key === 'Escape') { setViewId(null); setBoardForm(null); return; }
      if (modalOpen.current) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        if (document.activeElement?.matches('.text-node textarea')) document.activeElement.blur();
        insertSelection(selectedGraph(nodeRef.current, edgeRef.current)); return;
      }
      if (event.target.closest('textarea,input,[contenteditable="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
      if (event.key.toLowerCase() === 't' && !event.metaKey && !event.ctrlKey) addText(flow.screenToFlowPosition(mouse.current));
    };
    const unload = event => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('paste', paste); document.addEventListener('copy', copy); document.addEventListener('keydown', key); window.addEventListener('beforeunload', unload);
    return () => { document.removeEventListener('paste', paste); document.removeEventListener('copy', copy); document.removeEventListener('keydown', key); window.removeEventListener('beforeunload', unload); };
  }, [loaded]);

  const run = async nodeId => {
    if (starting) return;
    setStarting(nodeId);
    try {
      await saveNow();
      const result = await api(boardPath + '/runs', jsonOptions('POST', { nodeId, revision: base.current.revision }));
      setRuns(current => current.some(r => r.id === result.id) ? current : [...current, result]);
    } catch (error) { if (error.value?.graph) mergeRemote(error.value.graph); notify(error.message); }
    finally { setStarting(null); }
  };
  const cancel = async runId => { try { await api(`${boardPath}/runs/${runId}/cancel`, { method: 'POST' }); } catch (error) { notify(error.message); } };
  const connect = connection => {
    if (nodeRef.current.find(n => n.id === connection.target)?.type !== 'text') { notify('Connect inputs to a text prompt. Run creates image connections automatically.'); return; }
    const reachable = new Set();
    const walk = nodeId => { if (reachable.has(nodeId)) return; reachable.add(nodeId); edgeRef.current.filter(e => e.source === nodeId).forEach(e => walk(e.target)); };
    walk(connection.target);
    if (reachable.has(connection.source)) { notify('That connection would create a loop. Branch into a new prompt instead.'); return; }
    checkpoint(); putEdges(current => addEdge({ ...connection, id: id() }, current)); markDirty();
  };
  const connectEnd = (event, state) => {
    const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
    const onPane = pointer && document.elementFromPoint(pointer.clientX, pointer.clientY)?.classList.contains('react-flow__pane');
    if (!edgeDropCreatesPrompt(state, onPane)) return;
    const position = flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
    const node = addText({ x: position.x, y: position.y - 40 });
    putEdges(current => [...current, { id: id(), source: state.fromNode.id, target: node.id }]); setFocusId(node.id); markDirty();
  };
  const exportBoard = async () => {
    if (switchingRef.current || uploads.current || starting || !loaded) return;
    switchingRef.current = true; setTransfer('export');
    try {
      await saveNow();
      const response = await fetch(boardPath + '/export');
      if (!response.ok) throw new Error((await response.json()).error || 'Could not export board.');
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = currentBoard.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') + '.conceptgraph';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { notify(error.message); }
    finally { switchingRef.current = false; setTransfer(null); }
  };
  const importBoard = async file => {
    if (!file || switchingRef.current || uploads.current || starting || !loaded) return;
    switchingRef.current = true; setTransfer('import');
    try {
      if (file.size > 512 * 1024 * 1024) throw new Error('Choose a .conceptgraph file no larger than 512 MB.');
      await saveNow();
      const { board } = await api('/api/boards/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
      updateBoards(current => current.some(item => item.id === board.id) ? current : [...current, board]);
      selectBoard(board.id);
    } catch (error) { notify(error.message); }
    finally { switchingRef.current = false; setTransfer(null); }
  };
  const changeBoard = async (nextId, createName) => {
    if (switchingRef.current || uploads.current || starting || (!createName && nextId === boardId)) return;
    switchingRef.current = true; setSwitching(true);
    try {
      await saveNow();
      if (createName) {
        const board = await api('/api/boards', jsonOptions('POST', { name: createName }));
        updateBoards(current => current.some(b => b.id === board.id) ? current : [...current, board]);
        nextId = board.id;
      }
      selectBoard(nextId);
    } catch (error) { notify(error.message); }
    finally { switchingRef.current = false; setSwitching(false); }
  };
  const submitBoard = async event => {
    event.preventDefault();
    if (!nameDraft.trim()) return;
    if (boardForm === 'create') return changeBoard(null, nameDraft.trim());
    try {
      const board = await api(boardPath, jsonOptions('PATCH', { name: nameDraft.trim() }));
      updateBoards(current => current.map(b => b.id === board.id ? { ...b, name: board.name } : b));
      setBoardForm(null);
    } catch (error) { notify(error.message); }
  };
  const view = canvasView(nodes, edges, groups);
  const fitNodes = view.nodes.filter(node => node.selected && !node.hidden);
  const viewNode = nodes.find(node => node.id === viewId);
  const viewRun = runs.find(run => run.id === viewNode?.data.runId);
  const viewInputs = viewRun?.snapshot?.filter(node => node.id !== viewRun.nodeId) || [];
  const runningCount = runs.filter(busy).length;
  const selectedNodes = nodes.filter(n => n.selected), selectedCount = selectedNodes.length + groups.filter(group => group.selected).length;
  const canGroup = selectedNodes.length >= 2 && !groups.some(group => group.selected || group.nodeIds.some(id => selectedNodes.some(node => node.id === id)));
  const actions = { runs, edges, now, starting, checkpoint, focusId, clearFocus: () => setFocusId(null), toggleGroup, ungroup, editText: (nodeId, text) => { putNodes(current => current.map(node => node.id === nodeId ? { ...node, data: { ...node.data, text } } : node)); markDirty(); }, run, cancel, view: setViewId };

  return <Actions.Provider value={actions}><div className="app-shell" data-theme={theme}>
    <header className="app-header"><div className="brand"><img src="/favicon.svg" alt=""/><strong>Concept Graph</strong></div><div className="save-state"><span className={saved === 'All changes saved' ? 'saved-dot' : 'saving-dot'}/>{transfer === 'export' ? 'Exporting board…' : transfer === 'import' ? 'Importing board…' : switching ? 'Switching board…' : saved}</div><div className="header-right"><button className="theme-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} data-tooltip={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18}/></button><button className={`connection ${status.connected && status.signedIn && status.imageGeneration ? 'connected' : ''}`} onClick={() => api('/api/status', { method: 'POST' }).then(setStatus).catch(e => notify(e.message))} data-tooltip={status.error || 'Check Codex connection'}><span/>{status.connected && status.signedIn && status.imageGeneration ? 'Codex connected' : 'Check Codex'}</button></div></header>
    <aside className="sidebar" inert={!!transfer || switching ? true : undefined}>
      <div className="board-heading"><span className="eyebrow">YOUR BOARDS</span><div className="board-picker"><select data-tooltip="Switch board" aria-label="Board" value={boardId} disabled={switching || !!transfer || uploading || !!starting || !loaded} onChange={event => changeBoard(event.target.value)}>{boards.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}</select><button data-tooltip="Rename board" aria-label="Rename board" className="icon-button" disabled={switching || !!transfer || !loaded} onClick={() => { setNameDraft(currentBoard?.name || ''); setBoardForm('rename'); }}><Icon name="edit" size={15}/></button></div><button className="new-board" data-tooltip="Create a new board" disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={() => { setNameDraft(''); setBoardForm('create'); }}><Icon name="plus" size={15}/> New board</button><div className="board-transfer"><button data-tooltip="Save this board with its images" aria-label="Export board" disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={exportBoard}><Icon name="download" size={14}/> Export</button><button data-tooltip="Import a .conceptgraph file as a new board" aria-label="Import board" disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={() => boardFileInput.current.click()}><Icon name="upload" size={14}/> Import</button></div></div>
      <div className="sidebar-tabs"><button data-tooltip="Show creation tools" className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>Create</button><button data-tooltip="View generation history" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History <small>{runs.length}</small></button></div>
      {tab === 'canvas' ? <><div className="tool-list"><button disabled={!loaded || switching || !!transfer} data-tooltip="Add text prompt · T" aria-label="Add text prompt" onClick={() => addText()}><span className="tool-icon text"><Icon name="text"/></span><span>Text prompt</span><kbd>T</kbd></button><button disabled={!loaded || switching || !!transfer} data-tooltip="Upload reference images" aria-label="Add reference image" onClick={() => fileInput.current.click()}><span className="tool-icon image"><Icon name="image"/></span><span>Reference image</span></button></div><p className="paste-hint"><kbd>⌘ V</kbd> Paste text or an image.<br/>Drag a node’s output into empty space to add a prompt.<br/>Select nodes, then group them with the bottom toolbar.</p></> : <div className="history-list">{!runs.length && <p className="empty-history">Generations on this board will appear here.</p>}{[...runs].reverse().map(run => <div className={`history-item ${run.status}`} key={run.id}><button className="history-focus" data-tooltip="Show this generation" onClick={() => flow.fitView({ nodes: [{ id: run.nodeId }, ...run.outputIds.map(id => ({ id }))], duration: 350, padding: .25, maxZoom: 1 })}><span className="history-status"><Icon name={run.status === 'completed' ? 'check' : 'clock'} size={14}/> {busy(run) ? runTiming(run, runs, now).label : run.status}</span><strong>{run.label}</strong><small>{new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {run.outputIds.length} image{run.outputIds.length === 1 ? '' : 's'}</small></button>{busy(run) && <button className="cancel-link" data-tooltip="Cancel generation" onClick={() => cancel(run.id)}>Cancel run</button>}{run.error && <p>{run.error}</p>}</div>)}</div>}
      <div className="sidebar-bottom"><span className="legend-text"/> Text <span className="legend-image"/> Image</div>
    </aside>
    <main className="canvas" inert={switching || !!transfer || !loaded ? true : undefined} onPointerMove={event => { mouse.current = { x: event.clientX, y: event.clientY }; }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={event => { event.preventDefault(); addImages([...event.dataTransfer.files], flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
      <div className="canvas-top"><span>{currentBoard?.name}</span><span>{runningCount ? `${runningCount} generation${runningCount === 1 ? '' : 's'} in progress` : 'A little room to think bigger'}</span></div>
      <ReactFlow nodes={view.nodes} edges={view.edges} nodeTypes={nodeTypes} elevateNodesOnSelect={false} onNodesChange={nodesChanged} onEdgesChange={changes => { putEdges(current => applyEdgeChanges(changes, current)); if (changes.some(c => c.type !== 'select')) markDirty(); }} onConnect={connect} onConnectStart={(_, params) => setConnectionType(nodeRef.current.find(n => n.id === params.nodeId)?.type || 'text')} onConnectEnd={connectEnd} connectionLineStyle={{ stroke: connectionColor(connectionType), strokeWidth: 2 }} onNodeDragStart={checkpoint} onMoveStart={() => {
        // A canvas gesture keeps ownership when the pointer crosses an editor.
        if (document.activeElement?.matches('.text-node textarea')) document.activeElement.blur();
      }} onMoveEnd={(_, view) => { viewport.current = view; if (loaded) markDirty(); }} onPaneClick={() => setViewId(null)} defaultEdgeOptions={{ type: 'default' }} minZoom={.15} maxZoom={2} deleteKeyCode={null} panOnScroll selectionOnDrag panOnDrag={[1, 2]} selectionKeyCode="Shift" multiSelectionKeyCode="Meta" proOptions={{ hideAttribution: true }}>
        <Background color="var(--grid)" gap={24} size={1}/>
      </ReactFlow>
      {loaded && !nodes.length && <div className="empty-board"><div className="empty-glyph"><Icon name="branch" size={36}/></div><span className="eyebrow">ONE IDEA. MANY DIRECTIONS.</span><h2>What are you imagining?</h2><p>A character, a world, a detail worth exploring.<br/>Start with a prompt or paste a reference.</p><button className="primary-button" onClick={() => addText()}><Icon name="plus" size={16}/> Create your first prompt</button></div>}
      <div className="canvas-bottom"><div className="canvas-controls"><button data-tooltip="Undo · ⌘ Z" aria-label="Undo" onClick={() => undo()}><Icon name="undo" size={17}/></button><button data-tooltip="Redo · ⌘ Shift Z" aria-label="Redo" onClick={() => undo(true)}><Icon name="redo" size={17}/></button><i/><button data-tooltip="Zoom out" aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: 150 })}><Icon name="minus" size={16}/></button><button data-tooltip={fitNodes.length ? "Fit selected nodes in view" : "Fit all nodes in view"} aria-label="Fit canvas" onClick={() => flow.fitView({ nodes: fitNodes.length ? fitNodes : undefined, duration: 300, padding: .2, maxZoom: 1 })}><Icon name="expand" size={16}/></button><button data-tooltip="Zoom in" aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: 150 })}><Icon name="plus" size={16}/></button><i/><button data-tooltip="Align left to right · center parents" aria-label="Auto-align all nodes" disabled={!nodes.length} onClick={autoAlign}><Icon name="align" size={18}/></button><button data-tooltip={canGroup ? "Group selected nodes" : "Select 2+ ungrouped nodes"} aria-label="Group selected nodes" disabled={!canGroup} onClick={groupSelected}><Icon name="group" size={18}/></button>{selectedCount > 0 && <><i/><button data-tooltip="Delete selected" aria-label="Delete selected" onClick={removeSelected}><Icon name="trash" size={16}/></button></>}</div><span className="canvas-stats">{nodes.length} nodes <i/> {edges.length} connections</span></div>
    </main><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { addImages([...event.target.files]); event.target.value = ''; }}/>
    <input ref={boardFileInput} type="file" accept=".conceptgraph,.zip" aria-label="Board archive file" hidden onChange={event => { const file = event.target.files[0]; event.target.value = ''; importBoard(file); }}/>
    {boardForm && <div className="board-modal" role="dialog" aria-modal="true" aria-label={boardForm === 'create' ? 'Create board' : 'Rename board'}><form onSubmit={submitBoard}><h2>{boardForm === 'create' ? 'New board' : 'Rename board'}</h2><label htmlFor="board-name">Board name</label><input id="board-name" aria-label="Board name" autoFocus maxLength={80} value={nameDraft} onChange={event => setNameDraft(event.target.value)} placeholder="A new direction" disabled={switching}/><div><button data-tooltip="Cancel" type="button" onClick={() => setBoardForm(null)} disabled={switching}>Cancel</button><button className="primary-button" data-tooltip={boardForm === 'create' ? 'Create board' : 'Save board name'} type="submit" disabled={switching || !nameDraft.trim()}>{boardForm === 'create' ? 'Create board' : 'Save name'}</button></div></form></div>}
    {toast && <div className="toast" role="status">{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><Icon name="close" size={14}/></button></div>}
    {viewNode && <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image details" onClick={() => setViewId(null)}><div className="lightbox-card" onClick={event => event.stopPropagation()}>
      <button className="lightbox-close icon-button" autoFocus aria-label="Close image" onClick={() => setViewId(null)}><Icon name="close"/></button>
      <div className="lightbox-image"><img src={`/assets/${viewNode.data.asset}`} alt={viewNode.data.label || 'Concept image'}/></div>
      <div className="lightbox-details"><span className="eyebrow">{viewRun ? 'GENERATED CONCEPT' : 'REFERENCE IMAGE'}</span>
        {viewRun && <><span className="detail-label">Original prompt</span><p className="prompt-snapshot">{viewRun.target?.data.text || viewRun.label}</p>
          <span className="detail-label">Inputs at the time of this run</span>
          <div className="run-inputs">{viewInputs.length ? viewInputs.map((node, index) => node.type === 'image'
            ? <img key={node.id} src={`/assets/${node.data.asset}`} alt={`Input image ${index + 1}`} loading="lazy"/>
            : <p key={node.id}>{node.data.text}</p>) : <p>No connected inputs</p>}</div>
          <small>{new Date(viewRun.createdAt).toLocaleString()}</small></>}
        <div className="lightbox-actions"><a data-tooltip="Download original image" href={`/assets/${viewNode.data.asset}`} download={viewNode.data.asset}><Icon name="download" size={17}/> Download original</a></div>
      </div>
    </div></div>}
  </div><ButtonHelp/></Actions.Provider>;
}

function Workspace() {
  const [boards, setBoards] = useState([]), [boardId, setBoardId] = useState(null), [error, setError] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('concept-graph-theme') === 'dark' ? 'dark' : 'light');
  useEffect(() => { localStorage.setItem('concept-graph-theme', theme); document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    api('/api/workspace').then(workspace => {
      setBoards(workspace.boards);
      const remembered = localStorage.getItem('concept-graph-board');
      setBoardId(workspace.boards.some(b => b.id === remembered) ? remembered : workspace.defaultBoardId);
    }).catch(error => setError(error.message));
  }, []);
  const selectBoard = next => { localStorage.setItem('concept-graph-board', next); setBoardId(next); };
  if (!boardId) return <div className="startup">{error || 'Opening your boards…'}</div>;
  return <ReactFlowProvider key={boardId}><App boardId={boardId} boards={boards} updateBoards={setBoards} selectBoard={selectBoard} theme={theme} toggleTheme={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}/></ReactFlowProvider>;
}
createRoot(document.getElementById('root')).render(<Workspace/>);
