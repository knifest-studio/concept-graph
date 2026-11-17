import { codexGenerator, describeModel, gptDescribeModel, describeTask, generationSettings, generatorOf, generators, gptImageModel, isSiteGenerator, model3dModels, model3dTask, modelerOf, nanoModel, promptVariants, runInputList, runInputs, seedvrModel, topazModel, upscalerOf, upscalers, upscaleTask, withGenerator } from '../graph.mjs';

// What usage analytics records about a generation: the service and model that ran it, the kind of run, how many images
// it asked for and how many went in. Never the prompt, names, files or the room's wording of a failure.
// fal.ai runs 3D models and the Topaz and SeedVR2 upscales; a Nano Banana upscale stays with Gemini; descriptions use Gemini or GPT.
export const falGenerator = 'fal';
const upscaleModels = { [upscalers.topaz]: topazModel, [upscalers.seedvr]: seedvrModel, [upscalers.nanoBanana]: nanoModel };
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);

// From a run record, which decides: the room writes its own (provider, model, task, variants above one), and a Codex run
// is written in the tab that starts it (its model, a describe's task, the variants its strict count asks for).
export function recordedKind(run) {
  const task = [describeTask, upscaleTask, model3dTask].includes(run.task) ? run.task : 'image';
  const generator = task === model3dTask ? falGenerator : task === upscaleTask ? run.model === nanoModel ? generators.nanoBanana : falGenerator
    : isSiteGenerator(run.provider) ? run.provider : codexGenerator;
  return { generator, model: typeof run.model === 'string' ? run.model : undefined, task, variants: task === 'image' && Number.isInteger(run.variants) && run.variants > 1 ? run.variants : 1 };
}
// From a prompt the board's site route is starting, read the way the room reads it: any prompt that is not GPT Image runs
// on Nano Banana there.
export function siteKind(node) {
  const task = [describeTask, upscaleTask, model3dTask].includes(node?.data?.task) ? node.data.task : 'image';
  if (task === model3dTask) return { generator: falGenerator, model: model3dModels[modelerOf(node)], task, variants: 1 };
  if (task === upscaleTask) { const upscaler = upscalerOf(node); return { generator: upscaler === upscalers.nanoBanana ? generators.nanoBanana : falGenerator, model: upscaleModels[upscaler], task, variants: 1 }; }
  const gpt = generatorOf(node) === generators.gptImage;
  return { generator: gpt ? generators.gptImage : generators.nanoBanana, model: task === describeTask ? gpt ? gptDescribeModel : describeModel : gpt ? gptImageModel : nanoModel, task, variants: task === 'image' ? promptVariants(node) : 1 };
}

// The images a prompt would send, and whether one carries a mask (describe, upscale and 3D send none).
function sent(graph, nodeId) { try { return runInputs(graph, nodeId).images; } catch { return []; } }
const images = list => ({ references: list.length, masked: list.some(image => !!image.mask) });
// A prompt as Generate would run it now, on the site route or in Codex, for a start that never became a run (blocked by
// the helper or site access, or refused at the start).
export function promptAnalytics(graph, nodeId, { site = true } = {}) {
  const node = graph?.nodes?.find(item => item.id === nodeId);
  const kind = site ? siteKind(node) : { generator: codexGenerator, model: generationSettings.model, task: node?.data?.task === describeTask ? describeTask : 'image', variants: node?.data?.task === describeTask ? 1 : promptVariants(node) };
  return { ...kind, ...images(sent(graph, nodeId)) };
}
// A site run's start answers with its ID alone; its record follows over the board's socket, sometimes later. The caller
// adds the prompt's ID, so until the record arrives the prompt stands in for it.
export function runAnalytics(run, graph) {
  const record = run?.status ? run : null;
  if (!record) return { run: run?.id, ...promptAnalytics(run?.provider ? withGenerator(graph || { nodes: [{ id: run.nodeId, data: {} }], edges: [] }, run.nodeId, run.provider) : graph, run?.nodeId) };
  return { run: run.id, ...recordedKind(record), ...images(runInputList(record) || sent(graph, run.nodeId)) };
}

// The room's, the helper's and the providers' fixed failure texts, sorted by cause; the text itself is never sent unless
// the interface already shows it (analytics hides any other).
const failureKinds = [
  ['timeout', /took longer than|timed out|timeout|taking too long/i],
  ['refused', /declined|safety|content policy|moderation/i],
  ['quota', /daily limit|budget|quota|rate limit|variants fit|images fit/i],
  ['access', /available for your account|ask a site admin for access|access to the teammate/i],
  ['config', /site owner|site’s|api key|set up on this site|not available to/i],
  ['busy', /busy right now|try again in a minute/i],
  ['helper', /helper/i],
  ['interrupted', /interrupted|disconnected|left the board/i],
  ['reference', /reference|mask|too large|missing from storage|could not reduce|could not read the size|at least \d+ px|connect (?:fewer|an image|at most)/i],
  ['network', /network|fetch|could not reach|couldn’t reach/i],
  ['empty', /returned no/i]
];
// Names in the texts are quoted, so an image called “Daily limit” never reads as a quota.
export const failureKind = error => { const text = String(error || '').replace(/“[^”]*”|"[^"]*"/g, '…'); return failureKinds.find(([, pattern]) => pattern.test(text))?.[0] || 'provider'; };

// Follows the runs this tab starts until they end. `runs` is the board's runs map; `read` returns the board as this tab
// sees it. Turning analytics off forgets them.
export function runTracker({ runs, read, track, enabled }) {
  const own = new Map();
  const finished = run => {
    if (!enabled()) { own.clear(); return; }
    const started = own.get(run?.id);
    if (!started || !terminal(run.status)) return;
    own.delete(run.id);
    const failed = run.status === 'failed';
    // The record that ended the run is the room's (or the helper's) account of it; the images that went in stay as started.
    track(run.status === 'completed' ? 'generation_finished' : failed ? 'generation_failed' : 'generation_cancelled', {
      ...started, ...recordedKind(run), duration: Math.max(0, Date.parse(run.finishedAt || new Date().toISOString()) - Date.parse(run.startedAt || run.createdAt)),
      ...(failed ? { errorKind: failureKind(run.error), message: run.error || '' } : {}), count: run.outputIds?.length || 0
    });
  };
  const started = run => {
    if (!enabled() || !run?.id || own.has(run.id)) return;
    let graph; try { graph = read(); } catch {}
    const fields = runAnalytics(runs.get(run.id) || run, graph);
    own.set(run.id, fields); track('generation_started', fields);
    if (fields.task !== 'image') track(`${fields.task}_started`, fields);
    finished(runs.get(run.id) || run);
  };
  const changed = event => { for (const id of event.keysChanged) finished(runs.get(id)); };
  runs.observe(changed);
  return { started, clear: () => own.clear(), stop: () => { runs.unobserve(changed); own.clear(); } };
}
