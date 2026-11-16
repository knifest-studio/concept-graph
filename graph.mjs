import { isAnnotation, shiftArrow, validColor, validateAnnotation, validateAuthor, boardAuthor, annotationSize, canAttachStamp, detachMissingStampTargets, reconcileStampAttachments } from './src/annotations.mjs';
import { boardPages, defaultPageId, pageResolver, resolvePage, validatePages, validPageId } from './src/pages.mjs';
import { layerIndex, maxLayer, topLayer, validLayer } from './src/layers.mjs';
import { validateSections } from './src/sections.mjs';
import { validateImageEdits, generationReferences, maskInstruction, imageTitle } from './src/image-edits.mjs';
export { imageTitle };
import { maxModelBytes } from './src/model-assets.mjs';

const assetPattern = /^[\da-f-]{36}\.(png|jpg|webp|gif)$/;
export const generationSettings = Object.freeze({ model: 'gpt-6-luna', effort: 'low' });
// A prompt without `generator` uses Codex; cloud prompts can use a site API key instead.
export const generators = Object.freeze({ nanoBanana: 'nano-banana', gptImage: 'gpt-image' });
export const isSiteGenerator = value => Object.values(generators).includes(value);
// A describe node is a text node whose run writes a description of its connected images into a new text node.
export const describeTask = 'describe';
export const isDescribe = node => node?.type === 'text' && node.data?.task === describeTask;
// An upscale node is a text node whose run makes a larger copy of each connected image, on the site (never in Codex):
// Topaz or SeedVR2 through fal.ai, or Nano Banana redrawing it at 2K or 4K.
export const upscaleTask = 'upscale';
export const isUpscale = node => node?.type === 'text' && node.data?.task === upscaleTask;
export const model3dTask = 'model3d';
export const isModel3d = node => node?.type === 'text' && node.data?.task === model3dTask;
export const modelers = Object.freeze({ hunyuan: 'hunyuan', trellis: 'trellis', rodin: 'rodin', tripo: 'tripo' });
export const modelerOf = node => Object.values(modelers).includes(node?.data?.modeler) ? node.data.modeler : modelers.hunyuan;
export const maxModel3dImages = 4;
export const model3dModels = Object.freeze({ hunyuan: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d', trellis: 'fal-ai/trellis-2', rodin: 'fal-ai/hyper3d/rodin/v2.5', tripo: 'tripo3d/h3.1/image-to-3d' });
export const isGptImage = node => node?.type === 'text' && node.data?.generator === generators.gptImage && !isDescribe(node) && !isUpscale(node) && !isModel3d(node);
// A prompt switched to GPT Image keeps a connected main image, or takes the first image connected to it.
export function mainImageFor(nodes, edges, node) {
  if (!isGptImage(node)) return undefined;
  const images = new Set(nodes.filter(item => item.type === 'image').map(item => item.id));
  // Without a choice, the image numbered 1 (the first connected) is the one it edits.
  const inputs = connectedSources(edges, node.id).filter(id => images.has(id));
  return inputs.includes(node.data.mainImage) ? node.data.mainImage : inputs[0];
}
export const upscalers = Object.freeze({ topaz: 'topaz', seedvr: 'seedvr', nanoBanana: 'nano-banana' });
export const upscalerOf = node => Object.values(upscalers).includes(node?.data?.upscaler) ? node.data.upscaler : upscalers.topaz;
export const upscaleScale = node => node?.data?.scale === 4 ? 4 : 2;
export const maxUpscaleImages = 4;
// The pixel size a generated or upscaled image was stored at, shown as 2K, 4K and up on the board.
export function resolutionLabel(pixels) {
  const side = Math.max(pixels?.width || 0, pixels?.height || 0);
  // Nano Banana's 2K is 2752 px wide at 16:9, so 3K starts a little higher.
  return [[7600, '8K'], [5700, '6K'], [3800, '4K'], [2900, '3K'], [1900, '2K']].find(([least]) => side >= least)?.[1] || '';
}
export const maxDescription = 20000;
// A site-generated prompt can ask for up to this many variants, arriving as one slideshow. The room runs them a few at a
// time on one shared request, and the Workers Free plan allows 50 outside requests per run, so 32 leaves headroom.
export const maxVariants = 32;
// The one-click choices under a prompt; any other count up to maxVariants is typed in.
export const variantPresets = Object.freeze([1, 2, 4, 8, 16]);
export const clampVariants = value => Math.min(maxVariants, Math.max(1, Math.round(Number(value)) || 1));
export const promptVariants = node => Number.isInteger(node?.data?.variants) && node.data.variants >= 2 && node.data.variants <= maxVariants ? node.data.variants : 1;
export const nanoModel = 'gemini-nano-banana-2.1';
export const gptImageModel = 'gpt-image-2.5-flare';

// Generation settings on an image prompt. Each is its own optional top-level data field, so teammates changing different
// settings both keep their change (cloud nodes store every data field as one Yjs value), and an absent field is the
// generator's own default, exactly as prompts generated before settings existed. Switching generator keeps every value;
// one the new generator cannot use stays stored, is shown dimmed and is never sent.
// Shapes as width:height. Nano Banana 2.1 draws all of them (https://aistudio.google.com/docs/image-generation, read
// 2026-11-16); GPT Image keeps to 1:3–3:1 (https://developers.openai.com/api/reference/resources/images).
export const aspectRatios = Object.freeze(['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1']);
export const nanoOnlyRatios = Object.freeze(['1:4', '4:1', '1:8', '8:1']);
export const imageSizes = Object.freeze(['1K', '2K', '4K']);
// Absent is each provider's middle level: Nano Banana thinks at medium, GPT Image renders at medium quality.
export const nanoThinkingLevels = Object.freeze(['minimal', 'high']);
export const gptQualities = Object.freeze(['low', 'high']);
export const imageBackgrounds = Object.freeze(['transparent']);
export const generationFields = Object.freeze({ aspectRatio: aspectRatios, imageSize: imageSizes, nanoThinking: nanoThinkingLevels, gptQuality: gptQualities, background: imageBackgrounds });
const generationErrors = { aspectRatio: 'Invalid aspect ratio.', imageSize: 'Invalid output size.', nanoThinking: 'Invalid thinking level.', gptQuality: 'Invalid image quality.', background: 'Invalid image background.' };
export const codexGenerator = 'codex';
export const generatorOf = node => isSiteGenerator(node?.data?.generator) ? node.data.generator : codexGenerator;
// Only image prompts have settings: describe, upscale and 3D nodes keep their own controls.
export const takesGenerationSettings = node => node?.type === 'text' && node.data?.task === undefined;
export const requestedGeneration = data => Object.fromEntries(Object.entries(generationFields).filter(([key, values]) => values.includes(data?.[key])).map(([key]) => [key, data[key]]));
// A ratio as an image node's aspect (height / width).
export const ratioAspect = ratio => { const [width, height] = String(ratio ?? '').split(':').map(Number); return width > 0 && height > 0 ? height / width : undefined; };
// What each generator does with each setting. `shown` lists the rows its settings offer, in order; a stored value in a
// row it does not show (GPT Image's quality on a Nano Banana prompt) is kept and ignored.
const gptRatios = aspectRatios.filter(ratio => !nanoOnlyRatios.includes(ratio));
export const generationCapabilities = Object.freeze({
  [generators.nanoBanana]: Object.freeze({ shown: ['aspectRatio', 'imageSize', 'nanoThinking', 'background'], aspectRatio: aspectRatios, imageSize: imageSizes, nanoThinking: nanoThinkingLevels, gptQuality: [], background: [] }),
  // OpenAI calls sizes above 2560×1440 experimental.
  [generators.gptImage]: Object.freeze({ shown: ['aspectRatio', 'imageSize', 'gptQuality', 'background'], aspectRatio: gptRatios, imageSize: imageSizes, experimental: ['4K'], nanoThinking: [], gptQuality: gptQualities, background: imageBackgrounds }),
  // Codex's image tool takes only a prompt and a transparent-background flag (openai/codex rust-v0.163.0,
  // codex-rs/ext/image-generation/src/tool.rs): the shape is a request in the prompt, and the size is its own (~1.5 MP).
  [codexGenerator]: Object.freeze({ shown: ['aspectRatio', 'imageSize', 'background'], guidance: true, aspectRatio: gptRatios, imageSize: [], nanoThinking: [], gptQuality: [], background: imageBackgrounds }),
});
// Why a stored setting is not used; the interface translates these.
export const generationReasons = Object.freeze({
  nanoOnly: 'Only Nano Banana makes this shape.',
  masked: 'A masked edit keeps the shape of the image it changes.',
  codexSize: 'Codex picks the size (~1.5 MP). Add an Upscale node for 2K/4K.',
  nanoBackground: 'Nano Banana makes JPEG images, which cannot be transparent.',
  thinking: 'Only Nano Banana has a thinking setting.',
  quality: 'Only GPT Image has a quality setting.',
});
const unsupportedReasons = { aspectRatio: generationReasons.nanoOnly, imageSize: generationReasons.codexSize, nanoThinking: generationReasons.thinking, gptQuality: generationReasons.quality, background: generationReasons.nanoBackground };

// GPT Image 2.5 Flare takes any width × height in multiples of 16, 1:3 to 3:1, edges up to 3840 and 655,360 to 8,294,400
// pixels (https://developers.openai.com/api/docs/guides/image-generation, read 2026-11-16). 1K and 2K aim at the square's
// pixel count; 4K is the largest the limits allow.
export const gptSizeLimits = Object.freeze({ step: 16, maxRatio: 3, maxEdge: 3840, minPixels: 655360, maxPixels: 8294400 });
export function gptImagePixels(aspect, imageSize) {
  const { step, maxRatio, maxEdge, minPixels, maxPixels } = gptSizeLimits;
  const ratio = Math.min(maxRatio, Math.max(1 / maxRatio, Number.isFinite(aspect) && aspect > 0 ? 1 / aspect : 1));
  const target = imageSize === '4K' ? maxPixels : imageSize === '2K' ? 2048 * 2048 : 1024 * 1024;
  let width = Math.sqrt(target * ratio), height = width / ratio;
  const fit = Math.min(1, maxEdge / Math.max(width, height));
  width = Math.min(maxEdge, Math.round(width * fit / step) * step); height = Math.min(maxEdge, Math.round(height * fit / step) * step);
  // Rounding may pass a limit by one step; take it back from the side that passed it.
  while (width * height > maxPixels) { if (width >= height) width -= step; else height -= step; }
  while (width / height > maxRatio) width -= step;
  while (height / width > maxRatio) height -= step;
  while (width * height < minPixels) { if (width <= height) width += step; else height += step; }
  return { width, height };
}

/**
 * What one generator does with a prompt's settings: `requested` (what is stored), `applied` (what is used) and, for each
 * stored value not used, `unsupported[field]`, the reason. The board room, the Codex prompt, MCP and the interface all
 * read this, so they agree. `referenceSize` is the edited image's pixel size (the shape GPT Image keeps by default) and
 * `mask` whether a masked edit is sent.
 */
export function resolveGeneration(node, generator = generatorOf(node), { referenceSize, mask = false } = {}) {
  const requested = takesGenerationSettings(node) ? requestedGeneration(node.data) : {}, capabilities = generationCapabilities[generator] || generationCapabilities[codexGenerator];
  const applied = {}, unsupported = {};
  for (const [key, value] of Object.entries(requested)) {
    // GPT Image edits a masked image in place, so its output keeps that image's shape.
    const reason = !capabilities[key].includes(value) ? unsupportedReasons[key] : key === 'aspectRatio' && mask && generator === generators.gptImage ? generationReasons.masked : null;
    if (reason) unsupported[key] = reason; else applied[key] = value;
  }
  const result = { generator, requested, applied, unsupported, ...(applied.aspectRatio ? { aspect: ratioAspect(applied.aspectRatio) } : {}) };
  if (generator === generators.nanoBanana) {
    const format = { ...(applied.aspectRatio ? { aspect_ratio: applied.aspectRatio } : {}), ...(applied.imageSize ? { image_size: applied.imageSize } : {}) };
    result.nano = { ...(Object.keys(format).length ? { format: { type: 'image', ...format } } : {}), ...(applied.nanoThinking ? { config: { thinking_level: applied.nanoThinking } } : {}) };
  } else if (generator === generators.gptImage) {
    // Without a chosen shape or size the request keeps today's three preset sizes (cloud/gpt-image.mjs).
    const shape = result.aspect ?? (referenceSize?.width > 0 && referenceSize?.height > 0 ? referenceSize.height / referenceSize.width : undefined);
    const pixels = applied.aspectRatio || applied.imageSize ? gptImagePixels(shape, applied.imageSize) : undefined;
    result.gpt = { quality: applied.gptQuality || 'medium', ...(pixels ? { size: `${pixels.width}x${pixels.height}`, megapixels: pixels.width * pixels.height / 1e6 } : {}), ...(applied.background ? { background: applied.background } : {}) };
  } else result.codex = { lines: codexSettingLines(applied) };
  return result;
}

// A run keeps the settings its prompt asked for and those its generator used, for history and for the shape of its
// pending cards; a prompt without settings adds nothing, as before settings existed.
export const runSettings = generation => generation && Object.keys(generation.requested).length ? { settings: { requested: generation.requested, applied: generation.applied } } : {};

const orientation = aspect => aspect === 1 ? 'square' : aspect < 1 ? 'landscape, wider than tall' : 'portrait, taller than wide';
// Codex hears its settings as part of the request; the image tool itself takes only the transparent-background flag.
export const codexSettingLines = applied => [
  applied.aspectRatio ? `Aspect ratio: make each image ${applied.aspectRatio} (${orientation(ratioAspect(applied.aspectRatio))}).` : '',
  applied.background === 'transparent' ? 'Background: make each image with a transparent background (call the image tool with transparent_background).' : '',
].filter(Boolean);
// Describe nodes without Codex use a small Gemini model with image input on the same site key.
export const describeModel = 'gemini-3.5-flash-lite';
export const topazModel = 'fal-ai/topaz/upscale/image', seedvrModel = 'fal-ai/seedvr/upscale/image';
export const modelNames = Object.freeze({ [nanoModel]: 'Nano Banana 2.1', [gptImageModel]: 'GPT Image', [describeModel]: 'Gemini 3.5 Flash-Lite', [topazModel]: 'Topaz', [seedvrModel]: 'SeedVR2', [model3dModels.hunyuan]: 'Hunyuan 3D 3.1 Pro', [model3dModels.trellis]: 'TRELLIS 2', [model3dModels.rodin]: 'Rodin Gen-2.5', [model3dModels.tripo]: 'Tripo H3.1' });
export const templatePalette = Object.freeze(['#7c3aed', '#2563eb', '#0f766e', '#b45309', '#be185d', '#b91c1c', '#4d7c0f', '#4338ca', '#0369a1', '#9a3412']);

export function templateColor(template) {
  if (templatePalette.includes(template?.color)) return template.color;
  let hash = 0;
  for (const letter of template?.name || template?.id || '') hash = (hash * 31 + letter.codePointAt(0)) >>> 0;
  return templatePalette[hash % templatePalette.length];
}

export function nextTemplateColor(templates) {
  const counts = templatePalette.map(color => templates.filter(template => templateColor(template) === color).length);
  return templatePalette[counts.indexOf(Math.min(...counts))];
}

export function templateSnapshot(template) {
  return { name: template.name, instructions: template.instructions, assets: [...template.assets], color: templateColor(template) };
}

export function validateTemplate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80
    || typeof value.instructions !== 'string' || value.instructions.length > 100000
    || !Array.isArray(value.assets) || value.assets.length > 10 || !value.assets.every(asset => typeof asset === 'string' && assetPattern.test(asset))
    || (value.labelOutputs !== undefined && typeof value.labelOutputs !== 'boolean')
    || (value.color !== undefined && !templatePalette.includes(value.color))) {
    throw new Error('Invalid custom node template.');
  }
  return { name: value.name.trim(), instructions: value.instructions, assets: [...value.assets], ...(value.labelOutputs === true ? { labelOutputs: true } : {}), ...(value.color === undefined ? {} : { color: value.color }) };
}

// Large team boards hold tens of thousands of images; these bounds only stop runaway or hostile documents.
export const maxNodes = 250000, maxEdges = 500000;
export function validateGraph(value) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error('Invalid canvas.');
  if (value.nodes.length > maxNodes || value.edges.length > maxEdges) throw new Error('Canvas is too large.');
  if (value.pages !== undefined) validatePages(value.pages);
  const ids = new Set(), page = pageResolver(boardPages(value));
  for (const node of value.nodes) {
    if (!node || typeof node.id !== 'string' || node.id.length > 120 || ids.has(node.id)) throw new Error('Invalid or duplicate node.');
    ids.add(node.id);
    if (!['text', 'image', 'model', 'drawing', 'sticky', 'stamp', 'shape', 'arrow'].includes(node.type) || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)
      || !node.data || typeof node.data !== 'object' || Array.isArray(node.data)) throw new Error('Invalid node.');
    if (node.page !== undefined && !validPageId(node.page)) throw new Error('Invalid node page.');
    if (node.z !== undefined && !validLayer(node.z)) throw new Error('Invalid node layer.');
    if (isAnnotation(node)) validateAnnotation(node);
    if (node.data.author !== undefined) validateAuthor(node.data.author);
    if (node.data?.collapsed !== undefined && typeof node.data.collapsed !== 'boolean') throw new Error('Invalid node collapse state.');
    if (node.data?.createdAt !== undefined && (typeof node.data.createdAt !== 'string' || !Number.isFinite(Date.parse(node.data.createdAt)))) throw new Error('Invalid node creation time.');
    if (node.type === 'text' && (typeof node.data?.text !== 'string' || node.data.text.length > 100000)) throw new Error('Invalid text.');
    if (node.type === 'text' && node.data.model !== undefined && (typeof node.data.model !== 'string' || !/^[\w.\/:+-]{1,128}$/.test(node.data.model))) throw new Error('Invalid model.');
    if (node.type === 'text' && node.data.effort !== undefined && (typeof node.data.effort !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(node.data.effort))) throw new Error('Invalid reasoning effort.');
    if (node.type === 'text' && node.data.template !== undefined) validateTemplate(node.data.template);
    if (node.type === 'text' && node.data.labelOutputs !== undefined && typeof node.data.labelOutputs !== 'boolean') throw new Error('Invalid image caption setting.');
    if (node.type === 'text' && node.data.generator !== undefined && !isSiteGenerator(node.data.generator)) throw new Error('Invalid image generator.');
    if (node.type === 'text' && node.data.mainImage !== undefined && (typeof node.data.mainImage !== 'string' || node.data.mainImage.length > 120)) throw new Error('Invalid main image.');
    if (node.type === 'text' && node.data.generator === generators.gptImage && [describeTask, upscaleTask, model3dTask].includes(node.data.task)) throw new Error('GPT Image only generates images.');
    if (node.type === 'text' && node.data.task !== undefined && ![describeTask, upscaleTask, model3dTask].includes(node.data.task)) throw new Error('Invalid node task.');
    if (node.type === 'text' && node.data.upscaler !== undefined && !Object.values(upscalers).includes(node.data.upscaler)) throw new Error('Invalid upscaler.');
    if (node.type === 'text' && node.data.modeler !== undefined && !Object.values(modelers).includes(node.data.modeler)) throw new Error('Invalid 3D modeler.');
    if (node.type === 'model' && !/^[\da-f-]{36}\.glb$/.test(node.data.asset || '')) throw new Error('Invalid model asset.');
    if (node.type === 'model' && node.data.poster !== undefined && !/^[\da-f-]{36}\.(png|jpg|webp|gif)$/.test(node.data.poster)) throw new Error('Invalid model poster.');
    if (node.type === 'model' && (typeof node.data.name !== 'string' || !node.data.name.trim() || node.data.name.length > 120)) throw new Error('Invalid model name.');
    if (node.type === 'model' && node.data.modeler !== undefined && !Object.values(modelers).includes(node.data.modeler)) throw new Error('Invalid 3D modeler.');
    if (node.type === 'model' && node.data.uploaded !== undefined && typeof node.data.uploaded !== 'boolean') throw new Error('Invalid model upload flag.');
    if (node.type === 'model' && node.data.fileName !== undefined && (typeof node.data.fileName !== 'string' || !node.data.fileName.trim() || node.data.fileName.length > 1000)) throw new Error('Invalid model file name.');
    if (node.type === 'model' && node.data.bytes !== undefined && (!Number.isSafeInteger(node.data.bytes) || node.data.bytes < 20 || node.data.bytes > maxModelBytes)) throw new Error('Invalid model file size.');
    if (node.type === 'model' && node.data.usd !== undefined && (!Number.isFinite(node.data.usd) || node.data.usd < 0 || node.data.usd > 1000)) throw new Error('Invalid model cost.');
    // The card's camera, as model-viewer 4.4.0 writes it: getCameraOrbit() "θrad φrad rm", getCameraTarget() "xm ym zm".
    if (node.type === 'model' && node.data.view !== undefined) {
      const view = node.data.view, number = '-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?';
      if (!view || typeof view !== 'object' || Array.isArray(view) || Object.keys(view).some(key => !['orbit', 'target'].includes(key))
        || typeof view.orbit !== 'string' || view.orbit.length > 120 || !new RegExp(`^${number}rad ${number}rad ${number}m$`).test(view.orbit)
        || (view.target !== undefined && (typeof view.target !== 'string' || view.target.length > 120 || !new RegExp(`^${number}m ${number}m ${number}m$`).test(view.target)))) throw new Error('Invalid model view.');
    }
    if (node.type === 'model' && node.data.source !== undefined) {
      const source = node.data.source;
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['nodeId', 'name'].includes(key))
        || !['nodeId', 'name'].every(key => typeof source[key] === 'string' && source[key].trim() && source[key].length <= 120)) throw new Error('Invalid model source.');
    }
    if (node.type === 'text' && node.data.scale !== undefined && ![2, 4].includes(node.data.scale)) throw new Error('Invalid upscale size.');
    if (node.type === 'text' && node.data.variants !== undefined && (!Number.isInteger(node.data.variants) || node.data.variants < 2 || node.data.variants > maxVariants)) throw new Error('Invalid number of variants.');
    if (node.type === 'text') for (const [key, values] of Object.entries(generationFields)) if (node.data[key] !== undefined && !values.includes(node.data[key])) throw new Error(generationErrors[key]);
    if (node.type === 'text' && node.data.height !== undefined && (!Number.isFinite(node.data.height) || node.data.height < 60 || node.data.height > 4000)) throw new Error('Invalid prompt height.');
    if (node.type === 'image' && !assetPattern.test(node.data?.asset || '')) throw new Error('Invalid image asset.');
    if (node.type === 'image') validateImageEdits(node.data);
    if (node.type === 'image' && node.data.caption !== undefined && (typeof node.data.caption !== 'string' || node.data.caption.length > 120)) throw new Error('Invalid image caption.');
    if (node.type === 'image' && node.data.aspect !== undefined && (!Number.isFinite(node.data.aspect) || node.data.aspect < 0.1 || node.data.aspect > 10)) throw new Error('Invalid image aspect.');
    if (node.type === 'image' && node.data.pixels !== undefined && !['width', 'height'].every(side => Number.isInteger(node.data.pixels?.[side]) && node.data.pixels[side] > 0 && node.data.pixels[side] <= 100000)) throw new Error('Invalid image size.');
  }
  const edgeIds = new Set(), byId = new Map(value.nodes.map(node => [node.id, node]));
  for (const node of value.nodes) {
    const parent = node.type === 'stamp' && node.data.attachedTo !== undefined && byId.get(node.data.attachedTo);
    if (parent !== false && (!canAttachStamp(parent) || page(parent.page) !== page(node.page))) throw new Error('Invalid stamp attachment target.');
  }
  for (const edge of value.edges) {
    if (!edge || typeof edge.id !== 'string' || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) throw new Error('Invalid connection.');
    if (isAnnotation(byId.get(edge.source)) || isAnnotation(byId.get(edge.target))) throw new Error('Annotations cannot have connections.');
    if (page(byId.get(edge.source).page) !== page(byId.get(edge.target).page)) throw new Error('Connections cannot span pages.');
    edgeIds.add(edge.id);
  }
  const groupIds = new Set();
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || value.groups.length > value.nodes.length) throw new Error('Invalid groups.');
    const members = new Set();
    for (const group of value.groups) {
      if (!group || typeof group.id !== 'string' || !group.id || group.id.length > 120 || ids.has(group.id) || groupIds.has(group.id)
        || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 || typeof group.collapsed !== 'boolean'
        || (group.color !== undefined && !validColor(group.color))
        || (group.slideshow !== undefined && typeof group.slideshow !== 'boolean')
        || (group.slide !== undefined && (typeof group.slide !== 'string' || !group.slide || group.slide.length > 120))
        || !Array.isArray(group.nodeIds) || !group.nodeIds.length) throw new Error('Invalid group.');
      groupIds.add(group.id);
      for (const id of group.nodeIds) {
        if (!ids.has(id) || members.has(id)) throw new Error('A node can belong to only one group.');
        if (page(byId.get(id).page) !== page(byId.get(group.nodeIds[0]).page)) throw new Error('Groups cannot span pages.');
        members.add(id);
      }
    }
  }
  if (value.sections !== undefined) validateSections(value.sections, id => ids.has(id) || groupIds.has(id));
  if (value.viewport && !['x', 'y', 'zoom'].every(key => Number.isFinite(value.viewport[key]))) throw new Error('Invalid viewport.');
  // Every connection must remain acyclic, including image provenance.
  const incoming = new Map(value.nodes.map(n => [n.id, []]));
  value.edges.forEach(edge => incoming.get(edge.target).push(edge.source));
  // Iterative, so a chain of thousands of generations cannot overflow the call stack.
  const state = new Map();
  for (const node of value.nodes) {
    if (state.has(node.id)) continue;
    const stack = [[node.id, 0]]; state.set(node.id, 'visiting');
    while (stack.length) {
      const top = stack.at(-1), sources = incoming.get(top[0]);
      if (top[1] === sources.length) { state.set(top[0], 'done'); stack.pop(); continue; }
      const source = sources[top[1]++];
      if (state.get(source) === 'visiting') throw new Error('Connections cannot form a loop.');
      if (!state.has(source)) { state.set(source, 'visiting'); stack.push([source, 0]); }
    }
  }
  return value;
}

export function duplicateNodes(graph, nodeIds, { offset = { x: 40, y: 40 }, ids = new Map(nodeIds.map(id => [id, crypto.randomUUID()])), edgeIds = new Map(), createdAt = new Date().toISOString() } = {}) {
  const originals = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodeIds.some(id => !originals.has(id))) throw new Error('Node not found.');
  // Copies go on top of the board in their original stacking order.
  const top = topLayer(graph.nodes), rank = layerIndex(nodeIds.map(id => originals.get(id)));
  const nodes = nodeIds.map(id => {
    const node = originals.get(id);
    // A model copy keeps its generation facts; copying it did not generate a new GLB.
    const data = { ...structuredClone(node.data), ...(node.type === 'model' ? {} : { createdAt }) };
    if (node.type === 'model' && data.source && ids.has(data.source.nodeId)) data.source.nodeId = ids.get(data.source.nodeId);
    if (node.type === 'text' && data.mainImage !== undefined) {
      if (graph.edges.some(edge => edge.source === data.mainImage && edge.target === id)) data.mainImage = ids.get(data.mainImage) || data.mainImage;
      else delete data.mainImage;
    }
    if (node.type === 'stamp' && data.attachedTo !== undefined) {
      if (ids.has(data.attachedTo)) data.attachedTo = ids.get(data.attachedTo);
      else delete data.attachedTo;
    }
    // A copied arrow moves with its copy and holds on to copied nodes only; other ends stay where they were drawn.
    if (node.type === 'arrow') {
      Object.assign(data, shiftArrow(data, offset.x, offset.y));
      for (const end of [data.from, data.to]) { if (end.node !== undefined && ids.has(end.node)) end.node = ids.get(end.node); else delete end.node; }
    }
    return { id: ids.get(id), type: node.type, position: { x: node.position.x + offset.x, y: node.position.y + offset.y }, data, ...(node.page === undefined ? {} : { page: node.page }), z: Math.min(maxLayer, top + rank.get(id)) };
  });
  // Copies are listed in connection order and stored as new connections, so a copied prompt numbers its images the same.
  const edges = graph.edges.filter(edge => ids.has(edge.target)).sort(byConnection).map(edge => {
    if (!edgeIds.has(edge.id)) edgeIds.set(edge.id, crypto.randomUUID());
    return { id: edgeIds.get(edge.id), source: ids.get(edge.source) || edge.source, target: ids.get(edge.target) };
  });
  validateGraph(graph);
  if (nodes.some(node => originals.has(node.id))) throw new Error('Invalid or duplicate node.');
  // A clipboard source is not the destination board; validate copies with their external parents.
  validateGraph({ pages: graph.pages, nodes: detachMissingStampTargets([...graph.nodes.filter(node => !ids.has(node.id)), ...nodes]), edges });
  return { nodes, edges };
}

export function uniqueModelName(nodes, base) {
  base = (base || '3D model').trim().slice(0, 120);
  const used = new Set(nodes.filter(node => node.type === 'model').map(node => node.data.name));
  let name = base, number = 2;
  while (used.has(name)) { const suffix = ` ${number++}`; name = base.slice(0, 120 - suffix.length) + suffix; }
  return name;
}

export function imageName(node) {
  if (node?.data?.caption?.trim()) return node.data.caption.trim();
  const label = (node?.data?.label || '').trim().split(/[/\\]/).pop().replace(/\.[^.\s]+$/, '').trim();
  return label && !/^(image(?: \(\d+\))?|pasted image|reference image|result \d+)$/i.test(label) ? label.slice(0, 120) : 'Image';
}

export function uniqueImageName(nodes, base, exceptId) {
  base = (base || '').trim().slice(0, 120) || 'Image';
  const used = new Set(nodes.filter(node => node.type === 'image' && (exceptId === undefined || node.id !== exceptId)).map(imageName));
  if (base !== 'Image' && !used.has(base)) return base;
  // A taken generic "Image 4" becomes the next free "Image N", not "Image 4 2".
  if (/^image \d+$/i.test(base)) base = 'Image';
  let number = base === 'Image' ? 1 : 2, name;
  do { const suffix = ` ${number++}`; name = base.slice(0, 120 - suffix.length) + suffix; } while (used.has(name));
  return name;
}

// Name legacy inputs when connected; the caller checkpoints names and edges together.
export function nameImageConnections(nodes, edges, added) {
  const connected = [...edges];
  for (const edge of added) {
    const source = nodes.find(node => node.id === edge.source), target = nodes.find(node => node.id === edge.target);
    if (source?.type === 'image' && target?.type === 'text') {
      const peers = new Set(connected.filter(item => item.target === edge.target && item.source !== edge.source).map(item => item.source));
      if (!source.data.caption?.trim() || nodes.some(node => node.type === 'image' && peers.has(node.id) && imageName(node) === imageName(source))) {
        const caption = uniqueImageName(nodes, imageName(source), source.id);
        nodes = nodes.map(node => node === source ? { ...node, data: { ...node.data, caption } } : node);
      }
    }
    connected.push(edge);
  }
  return nodes;
}

// Every way a person can point at an image: the name shown above it, the node ID that Copy node ID gives, and the file
// name a download gets (plus the original name of an uploaded file).
const uploadedName = node => !node.data.runId && /\.[a-z\d]{2,5}$/i.test(node.data.label?.trim() || '') && node.data.label.trim() !== node.data.asset ? node.data.label.trim().slice(0, 200) : undefined;
export const imageReference = node => ({ asset: node.data.asset, label: imageName(node), nodeId: node.id, ...(node.data.mask ? { mask: node.data.mask } : {}), ...(uploadedName(node) ? { uploaded: uploadedName(node) } : {}) });
// A prompt numbers its connected images 1, 2, 3… in the order they were connected, and the board shows these numbers on
// the connections while the prompt is selected, so a request can say “image 2” or “the second image”. Connections that
// remember when they were made (`order`) follow that; older ones keep their stored order and come first.
// An order is a millisecond time; anything else (a crafted huge number, text) is ignored rather than trusted.
export const validOrder = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e14;
const connectionOrder = edge => validOrder(edge?.order) ? edge.order : -Infinity;
export const byConnection = (a, b) => { const x = connectionOrder(a), y = connectionOrder(b); return x === y ? 0 : x < y ? -1 : 1; };
// A local board's list is its connection order, so it stores none: an order from a team board's export is folded into the list.
export const localEdges = edges => [...edges].sort(byConnection).map(({ order, ...edge }) => edge);
export const connectedSources = (edges, nodeId) => [...new Set(edges.filter(edge => edge.target === nodeId).sort(byConnection).map(edge => edge.source))];
// Each connected image node's number, by node ID; `isImage` tells image nodes from prompts and custom nodes.
export function imageNumbers(edges, nodeId, isImage) {
  const numbers = new Map();
  for (const id of connectedSources(edges, nodeId)) if (isImage(id)) numbers.set(id, numbers.size + 1);
  return numbers;
}
const attachmentFiles = image => image.nodeId || image.asset
  ? ` (${[image.nodeId && `node ID ${image.nodeId}`, image.asset && `file ${image.asset}${image.uploaded ? `, uploaded as ${image.uploaded}` : ''}`].filter(Boolean).join('; ')})` : '';
// `index` is where the image is sent. A numbered image is named by its number (#2), not “Image 2”, which is a common board
// name of its own; one sent elsewhere says so, as GPT Image's edited image goes first.
const ownName = image => image.label && image.label !== 'Image' ? `: “${image.label}”` : '';
export const imageAttachment = (image, index) => image.marks
  ? `Attachment ${index + 1}: a copy of #${image.marks} with the area to edit marked in magenta`
  : image.number
    ? `#${image.number}${image.number === index + 1 ? '' : `, sent as attachment ${index + 1}`}${ownName(image)}${attachmentFiles(image)}`
    : `Attachment ${index + 1}: “${image.label}”${attachmentFiles(image)}`;
export const imageAttachments = images => images.length ? `Attached images, in the order they are sent. ${images.some(image => image.number) ? 'Each connected image has the number the board shows on its connection to this prompt (#1, #2, …). A number or position in the request (“#2”, “image 2”, “the second image”, “картинка 2”, “друга картинка”, in any language) means the image with that number, whatever position it is sent in and even when another image is named “Image 2”; a name in quotes means the image with exactly that name. ' : ''}The request may also point at an image by its name on the board, its node ID or its file name; each of these means that image:\n` + images.map(imageAttachment).join('\n') : '';

// What every generator receives for a prompt: the prompt and its directly connected nodes (their own ancestors are
// not sent, to keep runs small), the reference images in order with their labels, and the connected context texts.
export function runInputs(graph, nodeId) {
  validateGraph(graph);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const target = nodes.get(nodeId);
  if (target?.type !== 'text' || (!isDescribe(target) && !isUpscale(target) && !isModel3d(target) && !target.data.text.trim() && !target.data.template?.instructions.trim())) throw new Error('Write an image prompt first.');
  const ordered = connectedSources(graph.edges, nodeId).map(id => nodes.get(id)).concat(target);
  let number = 0;
  let images = ordered.flatMap(node => node.type === 'image' ? [{ ...imageReference(node), number: ++number }]
    : (node.type === 'text' ? node.data.template?.assets || [] : []).map((asset, index) => ({ asset, label: `${node.data.template.name} reference ${index + 1}` })));
  if (isDescribe(target) || isUpscale(target) || isModel3d(target)) images = images.map(({ mask, ...image }) => image);
  else {
    if (images.filter(image => image.mask).length > 1) throw new Error('Only one masked image per prompt. Remove the mask from the others or duplicate the node.');
    const stale = images.find(image => image.mask && image.mask.source !== image.asset);
    if (stale) throw new Error(`The mask on “${stale.label}” no longer matches the image. Paint it again.`);
  }
  if (isUpscale(target) || isModel3d(target)) {
    const model3d = isModel3d(target), limit = model3d ? maxModel3dImages : maxUpscaleImages;
    const pictures = ordered.filter(node => node.type === 'image').map(node => { const { mask, ...image } = imageReference(node); return image; });
    if (!pictures.length) throw new Error(model3d ? 'Connect an image to turn into 3D.' : 'Connect an image to upscale.');
    if (pictures.length > limit) throw new Error(`Connect at most ${limit} images to one ${model3d ? '3D' : 'upscale'} node.`);
    return { target, ordered, images: pictures, context: [] };
  }
  if (generationReferences(images, target.data.generator === generators.gptImage).length > 10) throw new Error('Use at most 10 connected reference images per run.');
  const mainImage = isGptImage(target) && target.data.mainImage !== undefined && images.find(image => image.nodeId === target.data.mainImage);
  if (mainImage) {
    const masked = images.find(image => image.mask);
    if (masked && masked !== mainImage) throw new Error(`The mask is on “${masked.label}”, but the main image is “${mainImage.label}”. Paint the mask on the main image or make “${masked.label}” the main image.`);
    images = [mainImage, ...images.filter(image => image !== mainImage)];
  }
  if (isDescribe(target) && !images.length) throw new Error('Connect an image to describe.');
  // A describe node's text only steers its own description; the prompts it feeds never see it.
  const context = ordered.filter(node => node.type === 'text' && node.id !== nodeId && !isDescribe(node) && (node.data.text.trim() || node.data.template?.instructions.trim()));
  return { target, ordered, images, context, ...(mainImage ? { mainImage } : {}) };
}

// A cloud run keeps a short list of the images it was given (a local run keeps a full snapshot instead), so its results
// can show them later: each image node with its ID, so the details can open it while it exists, its file and its name,
// and whether its mask went along; a custom node's references name that custom node. Runs send at most 10 images; the
// cap only bounds what a run stored in the shared document can hold.
export const maxRunInputs = 16;
const runInputKeys = new Set(['nodeId', 'asset', 'label', 'mask', 'template', 'number']);
const validRunInput = input => !!input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => runInputKeys.has(key))
  && typeof input.asset === 'string' && assetPattern.test(input.asset)
  && (input.nodeId === undefined || (typeof input.nodeId === 'string' && input.nodeId.length > 0 && input.nodeId.length <= 120))
  && (input.label === undefined || (typeof input.label === 'string' && input.label.length <= 120))
  && (input.mask === undefined || input.mask === true)
  && (input.number === undefined || (Number.isInteger(input.number) && input.number >= 1 && input.number <= 999))
  && (input.template === undefined || (typeof input.template === 'string' && !!input.template.trim() && input.template.length <= 80));
export function runInputRecord(graph, nodeId) {
  const { target, ordered, mainImage } = runInputs(graph, nodeId), picturesOnly = isUpscale(target) || isModel3d(target), masks = !picturesOnly && !isDescribe(target);
  // Mirrors runInputs: connected image nodes, with the numbers the prompt used, and, except for an upscale or 3D model,
  // the references of custom nodes.
  let number = 0;
  const record = ordered.flatMap(node => node.type === 'image'
    ? [{ nodeId: node.id, asset: node.data.asset, label: imageName(node).slice(0, 120), ...(picturesOnly ? {} : { number: ++number }), ...(masks && node.data.mask ? { mask: true } : {}) }]
    : !picturesOnly && node.type === 'text' && node.data.template ? node.data.template.assets.map(asset => ({ asset, template: node.data.template.name.trim().slice(0, 80) })) : []);
  // GPT Image edits its main image, which it receives first.
  if (mainImage) record.sort((a, b) => (b.nodeId === mainImage.nodeId) - (a.nodeId === mainImage.nodeId));
  return record.slice(0, maxRunInputs);
}
export function validateRunInputs(value) {
  if (value !== undefined && (!Array.isArray(value) || value.length > maxRunInputs || !value.every(validRunInput))) throw new Error('Invalid generation inputs.');
}
// Any editor can write a cloud run, so the details show only well-formed entries and never fail on the rest.
export const runInputList = run => Array.isArray(run?.inputs) ? run.inputs.slice(0, maxRunInputs).filter(validRunInput) : undefined;

export const promptText = node => [node.data.template?.instructions.trim() ? `Custom node instructions:\n${node.data.template.instructions}` : '', node.data.text.trim() ? node.data.text : ''].filter(Boolean).join('\n\n');

export function collectInputs(graph, nodeId, { maskInput = false } = {}) {
  const { target, ordered, images, context } = runInputs(graph, nodeId);
  // An upscale has no prompt; this shape only lets the editor notice changed inputs. Codex never runs it.
  if (isUpscale(target) || isModel3d(target)) return { prompt: '', images: images.map(image => image.asset), snapshot: structuredClone(ordered), target: structuredClone(target), task: target.data.task };
  if (isDescribe(target)) return { prompt: describePrompt(target, images, context), images: images.map(image => image.asset), snapshot: structuredClone(ordered), target: structuredClone(target), task: describeTask };
  const attachments = generationReferences(images, maskInput);
  if (attachments.length > 10) throw new Error('Use at most 10 connected reference images per run.');
  const prompt = [
    'Generate images for the final request. Earlier text is context, not additional jobs. The final request takes priority over older instructions.',
    ...context.map((node, i) => `Earlier context ${i + 1}:\n${promptText(node)}`),
    imageAttachments(attachments),
    `FINAL REQUEST:\n${promptText(target)}`,
    maskInstruction(images, maskInput),
    // The prompt's own settings, as Codex can follow them; a plain-text block, so helpers of any version pass it on.
    resolveGeneration(target, codexGenerator).codex.lines.join('\n'),
    'Return actual images with the built-in image tool. If multiple images are requested, generate each separately. Do not use a paid API fallback.',
  ].filter(Boolean).join('\n\n');
  if (prompt.length > 150000) throw new Error('Connected text is too long. Disconnect some context.');
  return { prompt, images: attachments.map(image => image.asset), snapshot: structuredClone(ordered), target: structuredClone(target) };
}

export function describePrompt(target, images, context) {
  return [
    'Describe the attached images in detail, so the description could be used as a prompt to recreate them.',
    ...context.map((node, i) => `Earlier context ${i + 1}:\n${promptText(node)}`),
    imageAttachments(images),
    promptText(target) ? `FOCUS:\n${promptText(target)}` : '',
    'Cover the subject, composition and framing, pose, materials and textures, colours, lighting, style, mood and background. Describe each image separately when there are several. Reply with the description only, in plain prose: no preamble, headings or questions. Do not generate images.',
  ].filter(Boolean).join('\n\n');
}

// The description lands in an ordinary prompt beside its describe node, ready to edit or generate from.
export function descriptionNode(run, text) {
  const author = boardAuthor(run.by);
  return {
    id: crypto.randomUUID(), type: 'text',
    position: { x: run.target.position.x + 390, y: run.target.position.y },
    data: { text: text.trim().slice(0, maxDescription), runId: run.id, createdAt: new Date().toISOString(), ...(author ? { author } : {}) },
  };
}

export function imageNode(run, asset, index, dimensions) {
  const aspect = dimensions && dimensions.height / dimensions.width;
  const author = boardAuthor(run.by);
  return {
    id: crypto.randomUUID(), type: 'image',
    position: { x: run.target.position.x + 390, y: run.target.position.y + index * 340 },
    data: { asset, label: `Result ${index + 1}`, runId: run.id, createdAt: new Date().toISOString(), ...(author ? { author } : {}), ...(aspect >= 0.1 && aspect <= 10 ? { aspect } : {}),
      ...(Number.isInteger(dimensions?.width) && Number.isInteger(dimensions?.height) && dimensions.width > 0 && dimensions.height > 0 ? { pixels: { width: dimensions.width, height: dimensions.height } } : {}) },
  };
}

export async function commitGraph(graph, next, persist) {
  const previous = { nodes: graph.nodes, edges: graph.edges, groups: graph.groups, pages: graph.pages, sections: graph.sections, viewport: graph.viewport, revision: graph.revision };
  const revision = graph.revision + 1;
  // A board without sections stores none, so it keeps its earlier form.
  const assign = value => { Object.assign(graph, value); if (graph.pages === undefined) delete graph.pages; if (!graph.sections?.length) delete graph.sections; };
  assign({ nodes: next.nodes, edges: next.edges, groups: next.groups, pages: next.pages, sections: next.sections === undefined ? graph.sections : next.sections, viewport: next.viewport || graph.viewport, revision });
  try { await persist(); } catch (error) { assign(previous); throw error; }
  return revision;
}

export function reconcileStampGraph(before, next) {
  const nodes = reconcileStampAttachments(before.nodes, next.nodes), retained = new Set(nodes.map(node => node.id));
  const removed = new Set(next.nodes.filter(node => !retained.has(node.id)).map(node => node.id));
  const groups = removed.size && Array.isArray(next.groups) ? next.groups.map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => !removed.has(id)) })).filter(group => group.nodeIds.length) : next.groups;
  return { ...next, nodes, ...(groups === undefined ? {} : { groups }) };
}

export function groupRunOutputs(graph, run, newOutputId) {
  const grouped = new Set((graph.groups || []).flatMap(group => group.nodeIds)), page = runOutputPage(graph, run), resolve = pageResolver(boardPages(graph));
  // A run whose page was deleted continues on the first page; a group never spans both.
  const existing = new Set(graph.nodes.filter(node => ['image', 'model'].includes(node.type) && resolve(node.page) === page).map(node => node.id));
  // Once the user removes this group, never recreate it during the same run.
  if (run.autoGroupId) {
    const group = (graph.groups || []).find(item => item.id === run.autoGroupId);
    if (!group || !newOutputId || !run.outputIds.includes(newOutputId) || !existing.has(newOutputId) || grouped.has(newOutputId)) return false;
    group.nodeIds.push(newOutputId);
    graph.revision++;
    return true;
  }
  const outputs = [...new Set(run.outputIds.filter(id => existing.has(id) && !grouped.has(id)))];
  if (outputs.length < 2) return false;
  const groups = graph.groups ||= [];
  const names = new Set(groups.map(group => group.name));
  let number = 1; while (names.has(`Group ${number}`)) number++;
  const id = crypto.randomUUID();
  // One run's images fold into a slideshow that shows one of them at a time.
  groups.push({ id, name: `Group ${number}`, nodeIds: outputs, collapsed: false, slideshow: !graph.nodes.some(node => outputs.includes(node.id) && node.type === 'model') });
  run.autoGroupId = id;
  graph.revision++;
  return true;
}

export const captionHeight = node => node.type === 'image' && !node.data?.collapsed ? 24 : 0;
export const nodeSize = node => isAnnotation(node) ? annotationSize(node) : node.data?.collapsed === true ? { width: 72, height: 72 }
  : node.type === 'model' ? { width: 310, height: 386 }
  : { width: node.measured?.width || 310, height: node.measured?.height || (node.type === 'text' ? node.data?.height || 80 : 310 * (node.data?.aspect || 1)) };

// An image prompt shows its settings row (with the variants on site generators) under the text.
export const promptRowHeight = node => takesGenerationSettings(node) ? 28 : 0;
// Shared with the canvas, so a server can reserve a prompt's text, settings row and Inputs row without browser measurements.
export function textNodeSize(node, inputs = false) {
  if (isModel3d(node)) return { width: 310, height: 180 };
  if (node.data?.height) return { width: 310, height: node.data.height };
  const lines = String(node.data?.text || '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 44)), 0);
  return { width: 310, height: Math.min(310, Math.round(58 + 22.1 * Math.min(lines, 400) + promptRowHeight({ type: 'text', ...node }) + (inputs ? 21.4 : 0))) };
}

// Outputs stay on the page frozen when the run was submitted, or the first page if it is gone.
export const runOutputPage = (graph, run) => resolvePage(boardPages(graph), run.page ?? defaultPageId);

// Read only image headers; usable with both browser Uint8Arrays and Node Buffers.
export function imageSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset, text) => offset + text.length <= bytes.length && [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const dimensions = (width, height) => width > 0 && height > 0 ? { width, height } : undefined;
  if (bytes.length >= 24 && tag(0, '\x89PNG\r\n\x1a\n') && tag(12, 'IHDR')) return dimensions(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 10 && (tag(0, 'GIF87a') || tag(0, 'GIF89a'))) return dimensions(view.getUint16(6, true), view.getUint16(8, true));
  if (tag(0, 'RIFF') && tag(8, 'WEBP')) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true), start = offset + 8;
      if (start + length > bytes.length) return;
      const uint24 = at => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
      if (tag(offset, 'VP8X') && length >= 10) return dimensions(uint24(start + 4) + 1, uint24(start + 7) + 1);
      if (tag(offset, 'VP8 ') && length >= 10 && tag(start + 3, '\x9d\x01\x2a')) return dimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
      if (tag(offset, 'VP8L') && length >= 5 && bytes[start] === 0x2f) {
        const bits = view.getUint32(start + 1, true);
        return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      offset = start + length + (length % 2);
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) return;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      offset += length;
    }
  }
}

export function imageFormat(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())) return 'gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Use a PNG, JPEG, WebP or GIF image.');
}
