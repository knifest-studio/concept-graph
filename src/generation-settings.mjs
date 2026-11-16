import { codexGenerator, generationCapabilities, generators, promptVariants, requestedGeneration, resolveGeneration } from '../graph.mjs';
import { nanoEstimate } from '../cloud/nano-banana.mjs';
import { gptImageEstimate } from '../cloud/gpt-image.mjs';
import { dollars } from './generator.mjs';
import { plural, t } from './i18n.mjs';

// What the settings chip and popover of an image prompt say. graph.mjs decides what each generator uses; this only words it.
export const generatorNames = Object.freeze({ [generators.nanoBanana]: 'Nano Banana', [generators.gptImage]: 'GPT Image', [codexGenerator]: 'Codex' });

// The quality levels share their English words with other levels whose Ukrainian takes another gender ("якість" is
// feminine), so they are looked up as "Low (quality)" and the like, and shown without the note when there is no translation.
const quality = word => { const key = `${word} (quality)`, shown = t(key); return shown === key ? word : shown; };
// A setting's value as the chip and popover name it; ratios and sizes read the same in every language.
export function settingLabel(key, value) {
  if (key === 'background') return value === 'transparent' ? t('Transparent') : t('Normal');
  if (key === 'nanoThinking') return value === 'minimal' ? t('Fast') : value === 'high' ? t('Thorough') : t('Normal');
  if (key === 'gptQuality') return quality(value === 'low' ? 'Low' : value === 'high' ? 'High' : 'Medium');
  return String(value);
}

/**
 * The chip's parts for a prompt under its generator: each stored setting in a row that generator offers, `off` (shown
 * dimmed, with its reason) when the generator cannot use it. A setting kept for another generator's row is left out.
 */
export function settingParts(node, generator, options) {
  const { requested, unsupported } = resolveGeneration(node, generator, options), shown = generationCapabilities[generator]?.shown || [];
  return shown.filter(key => requested[key] !== undefined).map(key => ({ key, value: requested[key], text: settingLabel(key, requested[key]), off: Object.hasOwn(unsupported, key), reason: unsupported[key] }));
}
export const partsText = parts => parts.length ? parts.map(part => part.text).join(' · ') : t('Default');

// A run's applied settings as History and run details show them, or '' for a run without any.
export function appliedSummary(settings) {
  const applied = settings?.applied && typeof settings.applied === 'object' ? requestedGeneration(settings.applied) : {};
  return Object.entries(applied).map(([key, value]) => settingLabel(key, value)).join(' · ');
}

/**
 * The popover's cost line. Site generators show what the board room holds from the team budget per image (the same
 * estimate it reserves, so never less than a call can cost) and for all variants; Codex uses the person's own ChatGPT.
 */
export function costLine(node, generator, { references = 0, cloud = true } = {}) {
  if (generator === codexGenerator) return cloud ? t('Uses your ChatGPT, not the team budget') : t('Uses your ChatGPT');
  const generation = resolveGeneration(node, generator), measure = { promptLength: String(node.data?.text || '').length, references };
  const each = generator === generators.gptImage ? gptImageEstimate({ ...measure, quality: generation.gpt.quality, megapixels: generation.gpt.megapixels })
    : nanoEstimate({ ...measure, imageSize: generation.applied.imageSize, thinking: generation.applied.nanoThinking });
  const count = promptVariants(node), price = t('≈ {price} per image', { price: dollars(each) });
  return count > 1 ? `${price} · ${plural(count, '{count} variant', '{count} variants')} ≈ ${dollars(each * count)}` : price;
}
