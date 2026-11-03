import { collectInputs, imageNode, imageSize, positionRunOutput, groupRunOutputs } from '../graph.mjs';
import { applyLocalGraph, readCloudGraph } from './cloud-sync.mjs';

const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const timestamp = () => new Date().toISOString();

async function base64(response) {
  if (!response.ok) throw new Error('Could not load a reference image.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 30 * 1024 * 1024) throw new Error('Reference images must be at most 30 MB.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

export class CloudGeneration {
  constructor({ doc, boardId, user, helperApi, helperRequest, api, request, ready, onError, onStart }) {
    Object.assign(this, { doc, boardId, user, helperApi, helperRequest, api, request, ready, onError, onStart });
    this.origin = {}; this.active = false; this.polling = false; this.submitting = new Set(); this.uncertain = new Set(); this.uploaded = new Map();
  }
  setRun(run) { this.doc.transact(() => this.doc.getMap('runs').set(run.id, run), this.origin); }
  startPolling() {
    this.active = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1500);
  }
  stop() { this.active = false; clearInterval(this.timer); }
  async start(nodeId) {
    if (!this.ready()) throw new Error('Wait for a live board connection before generating.');
    const graph = readCloudGraph(this.doc);
    if (graph.runs.some(run => run.nodeId === nodeId && ['running', 'queued'].includes(run.status))) return;
    const { prompt, images, target } = collectInputs(graph, nodeId);
    const inputs = await Promise.all(images.map(async asset => ({ asset, data: await base64(await this.request(`/assets/${asset}`)) })));
    if (!this.active || !this.ready()) throw new Error('Board disconnected. Try generating when it is live.');
    const run = { id: crypto.randomUUID(), nodeId, label: (target.data.text.trim() || target.data.template?.name || 'Generation').slice(0, 120), status: 'queued', by: this.user, startedAt: timestamp() };
    run.createdAt = run.startedAt;
    this.setRun(run); this.submitting.add(run.id);
    this.onStart?.(run);
    try {
      await this.helperApi('/api/cloud-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        jobId: run.id, boardId: this.boardId, nodeId, prompt, labelOutputs: target.data.labelOutputs, images: inputs,
      }) });
    } catch (error) {
      // A lost response may hide an accepted job; discovery will recover it without resubmitting.
      if (this.active && error.status) this.setRun({ ...run, status: 'failed', finishedAt: timestamp(), error: error.message });
      else this.uncertain.add(run.id);
      throw error;
    } finally { this.submitting.delete(run.id); }
    this.tick();
  }
  async cancel(id) {
    const run = this.doc.getMap('runs').get(id);
    if (!run || run.by?.name !== this.user.name || terminal(run.status)) return;
    await this.helperApi(`/api/cloud-jobs/${id}/cancel`, { method: 'POST' });
    if (this.active) await this.tick();
  }
  async complete(job) {
    const map = this.doc.getMap('runs');
    if (terminal(map.get(job.id)?.status)) return true;
    for (const output of job.outputs || []) {
      if (!this.active || !this.ready()) return false;
      const id = `${job.id}-output-${output.index}`;
      if (map.get(job.id)?.outputIds?.includes(id)) continue;
      const key = `${job.id}:${output.index}`;
      let uploaded = this.uploaded.get(key);
      if (!uploaded && !this.doc.getMap('nodes').has(id)) {
        const response = await this.helperRequest(`/api/cloud-jobs/${job.id}/outputs/${output.index}`);
        if (!response.ok) throw new Error('Could not collect a generated image. The helper will retain it for retry.');
        const blob = await response.blob(), dimensions = imageSize(new Uint8Array(await blob.arrayBuffer()));
        if (!this.active || !this.ready()) return false;
        const { asset } = await this.api('/api/assets', { method: 'POST', headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' }, body: blob });
        uploaded = { asset, dimensions }; this.uploaded.set(key, uploaded);
      }
      if (!this.active || !this.ready()) return false;
      this.doc.transact(() => {
        const current = map.get(job.id);
        if (terminal(current?.status) || current?.outputIds?.includes(id)) return;
        const before = readCloudGraph(this.doc), graph = structuredClone(before);
        const target = graph.nodes.find(node => node.id === job.nodeId) || { position: { x: 0, y: 0 } };
        const run = { ...(current || { id: job.id, nodeId: job.nodeId, by: this.user, label: 'Recovered generation' }), startedAt: job.startedAt || current?.startedAt, status: 'running', outputIds: [...(current?.outputIds || [])] };
        let node = graph.nodes.find(node => node.id === id);
        if (!node) {
          node = imageNode({ id: job.id, target }, uploaded.asset, output.index, uploaded.dimensions);
          node.id = id;
          if (output.caption || output.index > 0) node.data.caption = output.caption || `Image ${output.index + 1}`;
          positionRunOutput(node, graph, run);
          graph.nodes.push(node);
        }
        run.outputIds.push(id); run.count = run.outputIds.length;
        if (run.outputIds.length === 2) {
          const first = graph.nodes.find(node => node.id === run.outputIds[0]);
          if (first && !Object.hasOwn(first.data, 'caption')) first.data.caption = 'Image 1';
        }
        if (graph.nodes.some(item => item.id === job.nodeId) && !graph.edges.some(edge => edge.id === `${id}-edge`)) graph.edges.push({ id: `${id}-edge`, source: job.nodeId, target: id });
        const previousGroup = run.autoGroupId;
        groupRunOutputs(graph, run, id);
        if (!previousGroup && run.autoGroupId) {
          graph.groups.find(group => group.id === run.autoGroupId).id = `${job.id}-group`;
          run.autoGroupId = `${job.id}-group`;
        }
        graph.runs = [...graph.runs.filter(item => item.id !== job.id), run];
        applyLocalGraph(this.doc, graph, before, this.origin);
      }, this.origin);
    }
    if (!this.active || !this.ready()) return false;
    const current = map.get(job.id);
    if (!terminal(current?.status)) {
      const run = { ...(current || { id: job.id, nodeId: job.nodeId, by: this.user, label: 'Recovered generation' }), createdAt: current?.createdAt || current?.startedAt || job.startedAt, startedAt: job.startedAt || current?.startedAt, status: job.status,
        ...(terminal(job.status) ? { finishedAt: job.finishedAt || timestamp(), count: current?.outputIds?.length || 0 } : {}), ...(job.error ? { error: job.error } : {}) };
      if (JSON.stringify(run) !== JSON.stringify(current)) this.setRun(run);
    }
    return true;
  }
  async tick() {
    if (!this.active || !this.ready() || this.polling) return;
    this.polling = true;
    try {
      const uncertain = [...this.uncertain];
      const { jobs } = await this.helperApi('/api/cloud-jobs');
      if (!this.active || !this.ready()) return;
      for (const id of uncertain) {
        if (!jobs.some(job => job.id === id)) {
          const run = this.doc.getMap('runs').get(id);
          if (['running', 'queued'].includes(run?.status)) this.setRun({ ...run, status: 'failed', finishedAt: timestamp(), error: 'The helper did not accept this job. Run the prompt again.' });
        }
        this.uncertain.delete(id);
      }
      for (const job of jobs.filter(job => job.boardId === this.boardId)) {
        if (!this.active || !this.ready()) break;
        if (this.submitting.has(job.id)) continue;
        if (!await this.complete(job)) continue;
        if (terminal(job.status) && this.active && this.ready()) {
          await this.helperApi(`/api/cloud-jobs/${job.id}`, { method: 'DELETE' });
          for (const key of this.uploaded.keys()) if (key.startsWith(`${job.id}:`)) this.uploaded.delete(key);
        }
      }
    } catch (error) { if (this.active) this.onError(error.message || 'Local helper unavailable. Collection will retry.', error); }
    finally { this.polling = false; }
  }
}
