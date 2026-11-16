import { codexGenerator, describeTask, generators, isSiteGenerator, upscaleTask, model3dTask } from '../graph.mjs';
import { t } from './i18n.mjs';

// Upscaling always runs on the site, whatever the node's generator says.
export const usesSiteGenerator = data => isSiteGenerator(data?.generator) || [upscaleTask, model3dTask].includes(data?.task);
export const dollars = value => `$${value.toFixed(2).replace(/\.00$/, '')}`;

// The generator a new image prompt or describe node starts on (null is Codex). On Nov 16 a fifth of the newcomers'
// Generate presses opened helper pairing because every new prompt started on Codex, though they could use the team
// key. So a prompt starts on the generator this person last used, while it still works for them; failing that, on the
// team key when their own Codex isn't ready and the key is theirs to use; otherwise on Codex, the only generator
// everyone has. Until the site says what this person may use, only a generator they used before is assumed to work.
// `nano` and `gpt` are nanoState results; describe nodes use Gemini on the Nano Banana key and have no GPT Image.
export function startingGenerator({ describe = false, last, codexReady, known, nano, gpt }) {
  const works = generator => generator === codexGenerator ? codexReady
    : generator === generators.nanoBanana ? (known || last === generator) && (describe ? nano.selectable : nano.ready)
      : generator === generators.gptImage ? !describe && (known || last === generator) && gpt.ready : false;
  if (last && works(last)) return last === codexGenerator ? null : last;
  if (!codexReady) for (const generator of [generators.nanoBanana, generators.gptImage]) if (known && works(generator)) return generator;
  return null;
}
// Per browser and kind: what this person last chose or ran. Image prompts and describe nodes are remembered apart.
export const lastGeneratorKey = 'concept-graph-last-generator';
export const generatorKind = data => data?.task === describeTask ? 'describe' : data?.task === undefined ? 'image' : null;
export function readLastGenerators(storage = globalThis.localStorage) {
  try { const value = JSON.parse(storage.getItem(lastGeneratorKey)); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
export function rememberGenerator(data, generator, storage = globalThis.localStorage) {
  const kind = generatorKind(data), value = isSiteGenerator(generator) ? generator : codexGenerator;
  if (!kind || (kind === 'describe' && value === generators.gptImage)) return;
  try { storage.setItem(lastGeneratorKey, JSON.stringify({ ...readLastGenerators(storage), [kind]: value })); } catch {}
}

// What a site provider can do for this person, from GET /api/nano. Until it answers, Generate is left to the server.
// `access` says who gives access and whether this person asked for it (GET /api/nano adds both for people without it);
// `short` labels an option that can't be chosen, and `requestable` offers Request access for the team's image key.
export function nanoState(status, generator = generators.nanoBanana, access = status) {
  const names = Array.isArray(access?.admins) ? access.admins.filter(name => typeof name === 'string' && name).join(', ') : '', requested = !!access?.requested;
  const fal = status?.fal !== false, gpt = generator === generators.gptImage, model3d = generator === model3dTask;
  if (!status) return { selectable: true, ready: true, note: model3d ? t('3D generation runs on the site, not in Codex.') : gpt ? t('Uses the site’s OpenAI key') : t('Uses the site’s Gemini key'), budget: '', fal };
  if (!status.configured) return { selectable: false, ready: false, short: t('not set up'), note: model3d ? t('3D generation isn’t set up on this site. Ask the site owner to add a fal.ai key.') : gpt ? t('GPT Image isn’t set up on this site') : t('Nano Banana isn’t set up on this site'), budget: '', fal };
  if (!status.allowed && requested && !model3d) return { selectable: false, ready: false, short: t('requested'), requestable: false, requested, budget: '', fal,
    note: names ? t('Access requested. {names} will see it in Team access.', { names }) : t('Access requested. A site admin will see it in Team access.') };
  if (!status.allowed) return { selectable: false, ready: false, short: t('no access'), requestable: !model3d, requested: false, note: names ? model3d ? t('3D generation isn’t available for your account yet. Ask {names}: site admins give access in Team access.', { names }) : t('Not available for your account yet. Ask {names}: site admins give access in Team access.', { names })
    : model3d ? t('3D generation isn’t available for your account. Ask a site admin for access.') : t('Not available for your account. Ask a site admin for access.'), budget: '', fal };
  const left = Math.max(0, status.dailyImages - status.usedToday), budget = t('Team: {spent} of {limit} this month', { spent: dollars(status.teamSpentUsd), limit: dollars(status.monthlyUsd) });
  if (!left) return { selectable: true, ready: false, note: t('Daily limit reached ({used}/{limit})', { used: Math.min(status.usedToday, status.dailyImages), limit: status.dailyImages }), budget, fal };
  if (status.teamSpentUsd >= status.monthlyUsd) return { selectable: true, ready: false, note: t('Team budget for this month is used up'), budget, fal };
  return { selectable: true, ready: true, note: t('{left} of {limit} left today', { left, limit: status.dailyImages }), budget, fal };
}
