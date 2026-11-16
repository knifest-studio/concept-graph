import test from 'node:test';
import assert from 'node:assert/strict';
import { aspectRatios, codexGenerator, collectInputs, generationCapabilities, generationFields, generationReasons, gptImagePixels, gptSizeLimits, imageSizes, nanoOnlyRatios, ratioAspect, resolveGeneration, runSettings, textNodeSize, validateGraph } from '../graph.mjs';
import { nanoCost, nanoEstimate, nanoRequest } from '../cloud/nano-banana.mjs';
import { gptImageEstimate, gptImageRequest } from '../cloud/gpt-image.mjs';
import { checkArgs, runBoardTool, toolByName } from '../cloud/mcp-tools.mjs';
import { expectedOutputs } from '../src/output-placement.mjs';
import { runPlaceholders } from '../src/run-placeholders.mjs';
import { appliedSummary, costLine, partsText, settingParts } from '../src/generation-settings.mjs';
import { setLanguage, t } from '../src/i18n.mjs';
import uk from '../src/locales/uk.mjs';

const prompt = (data = {}) => ({ id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A courier robot', ...data } });
const nano = 'nano-banana', gpt = 'gpt-image';

test('settings are optional flat fields on text nodes, validated against their own values', () => {
  validateGraph({ nodes: [prompt()], edges: [] });
  for (const [key, values] of Object.entries(generationFields)) {
    for (const value of values) validateGraph({ nodes: [prompt({ [key]: value })], edges: [] });
    for (const value of ['', 'auto', 2, null, 'medium', '3:7']) assert.throws(() => validateGraph({ nodes: [prompt({ [key]: value })], edges: [] }), /^Error: Invalid (aspect ratio|output size|thinking level|image quality|image background)\.$/);
  }
  // The middle levels are the defaults and are never stored.
  assert.ok(!generationFields.nanoThinking.includes('medium') && !generationFields.gptQuality.includes('medium'));
  assert.deepEqual(aspectRatios.filter(ratio => !generationCapabilities[gpt].aspectRatio.includes(ratio)), [...nanoOnlyRatios]);
});

test('a prompt without settings resolves to exactly today’s requests for every generator', () => {
  for (const generator of [nano, gpt, codexGenerator, undefined]) {
    const resolved = resolveGeneration(prompt(), generator);
    assert.deepEqual([resolved.requested, resolved.applied, resolved.unsupported, resolved.aspect], [{}, {}, {}, undefined]);
  }
  assert.deepEqual(resolveGeneration(prompt(), nano).nano, {});
  assert.deepEqual(resolveGeneration(prompt(), gpt).gpt, { quality: 'medium' });
  assert.deepEqual(resolveGeneration(prompt(), codexGenerator).codex, { lines: [] });
  assert.deepEqual(runSettings(resolveGeneration(prompt(), nano)), {});
  // Describe, upscale and 3D nodes have no settings, whatever is stored on them.
  for (const task of ['describe', 'upscale', 'model3d']) assert.deepEqual(resolveGeneration(prompt({ task, aspectRatio: '16:9' }), nano).requested, {});
});

test('Nano Banana uses every shape, size and thinking level, and cannot make a transparent background', () => {
  const all = { aspectRatio: '8:1', imageSize: '4K', nanoThinking: 'minimal', gptQuality: 'high', background: 'transparent' };
  const resolved = resolveGeneration(prompt(all), nano);
  assert.deepEqual(resolved.applied, { aspectRatio: '8:1', imageSize: '4K', nanoThinking: 'minimal' });
  assert.deepEqual(resolved.unsupported, { gptQuality: generationReasons.quality, background: generationReasons.nanoBackground });
  assert.deepEqual(resolved.nano, { format: { type: 'image', aspect_ratio: '8:1', image_size: '4K' }, config: { thinking_level: 'minimal' } });
  assert.equal(resolved.aspect, 1 / 8);
  assert.deepEqual(resolveGeneration(prompt({ imageSize: '2K' }), nano).nano, { format: { type: 'image', image_size: '2K' } });
  assert.deepEqual(resolveGeneration(prompt({ nanoThinking: 'high' }), nano).nano, { config: { thinking_level: 'high' } });
  assert.deepEqual(runSettings(resolved), { settings: { requested: all, applied: resolved.applied } });
});

test('GPT Image sizes are multiples of 16 within OpenAI’s limits, 4K the largest that fits', () => {
  const { step, maxRatio, maxEdge, minPixels, maxPixels } = gptSizeLimits;
  for (const ratio of generationCapabilities[gpt].aspectRatio) for (const size of [undefined, ...imageSizes]) {
    const { width, height } = gptImagePixels(ratioAspect(ratio), size), label = `${ratio} ${size}`;
    assert.ok(width % step === 0 && height % step === 0, label);
    assert.ok(width <= maxEdge && height <= maxEdge && width * height <= maxPixels && width * height >= minPixels, label);
    assert.ok(width / height <= maxRatio && height / width <= maxRatio, label);
    // The shape stays the chosen one, give or take one step of rounding.
    assert.ok(Math.abs(Math.log((height / width) / ratioAspect(ratio))) < .02, label);
  }
  assert.deepEqual(gptImagePixels(1, '1K'), { width: 1024, height: 1024 });
  assert.deepEqual(gptImagePixels(9 / 16, '1K'), { width: 1360, height: 768 });
  assert.deepEqual(gptImagePixels(1, '2K'), { width: 2048, height: 2048 });
  assert.deepEqual(gptImagePixels(1, '4K'), { width: 2880, height: 2880 });
  assert.deepEqual(gptImagePixels(9 / 16, '4K'), { width: 3840, height: 2160 });
  assert.deepEqual(gptImagePixels(16 / 9, '4K'), { width: 2160, height: 3840 });
  assert.deepEqual(gptImagePixels(9 / 21, '4K'), { width: 3840, height: 1648 });
  // Shapes beyond 1:3 (an edited image's, say) are brought back to it.
  assert.deepEqual(gptImagePixels(1 / 8, '1K'), gptImagePixels(1 / 3, '1K'));
  assert.equal(gptImagePixels(1 / 3, '1K').width / gptImagePixels(1 / 3, '1K').height, 3);
});

test('GPT Image resolves size, quality and background; Nano-only shapes and masked edits keep the default shape', () => {
  const resolved = resolveGeneration(prompt({ aspectRatio: '16:9', imageSize: '2K', gptQuality: 'high', nanoThinking: 'high', background: 'transparent' }), gpt);
  assert.deepEqual(resolved.applied, { aspectRatio: '16:9', imageSize: '2K', gptQuality: 'high', background: 'transparent' });
  assert.deepEqual(resolved.unsupported, { nanoThinking: generationReasons.thinking });
  assert.deepEqual(resolved.gpt, { quality: 'high', size: '2736x1536', megapixels: 2736 * 1536 / 1e6, background: 'transparent' });
  const tall = resolveGeneration(prompt({ aspectRatio: '1:8' }), gpt);
  assert.deepEqual([tall.applied, tall.unsupported, tall.gpt], [{}, { aspectRatio: generationReasons.nanoOnly }, { quality: 'medium' }]);
  // A size alone follows the edited image's shape; with nothing to edit, a square.
  assert.equal(resolveGeneration(prompt({ imageSize: '2K' }), gpt, { referenceSize: { width: 1600, height: 900 } }).gpt.size, '2736x1536');
  assert.equal(resolveGeneration(prompt({ imageSize: '2K' }), gpt).gpt.size, '2048x2048');
  // A masked edit keeps its image's shape: the chosen shape is set aside, the size still applies.
  const masked = resolveGeneration(prompt({ aspectRatio: '9:16', imageSize: '2K' }), gpt, { mask: true, referenceSize: { width: 1000, height: 1000 } });
  assert.deepEqual([masked.applied, masked.unsupported, masked.gpt.size, masked.aspect], [{ imageSize: '2K' }, { aspectRatio: generationReasons.masked }, '2048x2048', undefined]);
  assert.deepEqual(resolveGeneration(prompt({ aspectRatio: '9:16' }), gpt, { mask: true }).gpt, { quality: 'medium' });
});

test('Codex hears the shape and a transparent background in its prompt; size and the other providers’ levels are not its', () => {
  const resolved = resolveGeneration(prompt({ aspectRatio: '16:9', imageSize: '4K', nanoThinking: 'high', gptQuality: 'low', background: 'transparent' }), codexGenerator);
  assert.deepEqual(resolved.applied, { aspectRatio: '16:9', background: 'transparent' });
  assert.deepEqual(resolved.unsupported, { imageSize: generationReasons.codexSize, nanoThinking: generationReasons.thinking, gptQuality: generationReasons.quality });
  assert.deepEqual(resolved.codex.lines, ['Aspect ratio: make each image 16:9 (landscape, wider than tall).', 'Background: make each image with a transparent background (call the image tool with transparent_background).']);
  assert.deepEqual(resolveGeneration(prompt({ aspectRatio: '1:4' }), codexGenerator).unsupported, { aspectRatio: generationReasons.nanoOnly });
  assert.match(resolveGeneration(prompt({ aspectRatio: '3:4' }), codexGenerator).codex.lines[0], /3:4 \(portrait, taller than wide\)/);
  assert.match(resolveGeneration(prompt({ aspectRatio: '1:1' }), codexGenerator).codex.lines[0], /1:1 \(square\)/);
  // Settings for Codex follow the prompt, whatever generator a cloud prompt names, since collectInputs is Codex's.
  const graph = data => ({ nodes: [prompt(data)], edges: [] });
  const plain = collectInputs(graph({}), 'p').prompt, set = collectInputs(graph({ generator: nano, aspectRatio: '9:16', background: 'transparent', imageSize: '2K' }), 'p').prompt;
  assert.doesNotMatch(plain, /Aspect ratio|Background:/);
  const final = set.indexOf('Return actual images with the built-in image tool.');
  assert.ok(set.indexOf('FINAL REQUEST:') < set.indexOf('Aspect ratio: make each image 9:16') && set.indexOf('Aspect ratio') < set.indexOf('Background: make each image') && set.indexOf('Background:') < final);
  assert.equal(set.replace(/\n\nAspect ratio: [^\n]+\nBackground: [^\n]+/, ''), plain);
  assert.doesNotMatch(set, /2K/);
});

test('Nano Banana requests carry response_format and generation_config only for chosen settings', () => {
  const options = { key: 'k', endpoint: 'https://example.test' }, body = (...extra) => JSON.parse(nanoRequest('A robot', [], options, undefined, ...extra).init.body);
  const plain = body();
  assert.deepEqual(Object.keys(plain), ['model', 'input', 'store']);
  assert.deepEqual(body(undefined, undefined), plain);
  const chosen = resolveGeneration(prompt({ aspectRatio: '21:9', imageSize: '2K', nanoThinking: 'high' }), nano).nano;
  assert.deepEqual(body(chosen.format, chosen.config), { ...plain, response_format: { type: 'image', aspect_ratio: '21:9', image_size: '2K' }, generation_config: { thinking_level: 'high' } });
  const sizeOnly = resolveGeneration(prompt({ imageSize: '4K' }), nano).nano;
  assert.deepEqual(body(sizeOnly.format, sizeOnly.config), { ...plain, response_format: { type: 'image', image_size: '4K' } });
});

test('GPT Image requests take the resolved size, quality and transparent background', () => {
  const plain = JSON.parse(gptImageRequest('A robot', [], { key: 'k' }).init.body);
  assert.deepEqual([plain.size, plain.quality, plain.background], ['1024x1024', 'medium', undefined]);
  const chosen = resolveGeneration(prompt({ aspectRatio: '3:4', imageSize: '4K', gptQuality: 'low', background: 'transparent' }), gpt).gpt;
  const body = JSON.parse(gptImageRequest('A robot', [], { key: 'k', ...chosen }).init.body);
  assert.deepEqual(body, { ...plain, size: chosen.size, quality: 'low', background: 'transparent' });
  assert.equal(body.output_format, 'png');
  assert.deepEqual(chosen.size.split('x').map(Number), [2496, 3312]);
});

test('estimates grow with Nano Banana’s size and thinking and GPT Image’s quality and pixels; defaults are unchanged', () => {
  const measure = { promptLength: 300, references: 1 };
  assert.equal(nanoEstimate(measure), ((100 + 1120) * 1.5 + 1120 * 30 + 4000 * 7.5) / 1e6);
  assert.equal(nanoEstimate({ ...measure, imageSize: '1K', thinking: 'medium' }), nanoEstimate(measure));
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≉ ${b}`);
  close(nanoEstimate({ ...measure, imageSize: '2K' }) - nanoEstimate(measure), (1680 - 1120) * 30 / 1e6);
  close(nanoEstimate({ ...measure, imageSize: '4K' }) - nanoEstimate(measure), (3780 - 1120) * 30 / 1e6);
  assert.ok(nanoEstimate({ ...measure, thinking: 'minimal' }) < nanoEstimate(measure) && nanoEstimate(measure) < nanoEstimate({ ...measure, thinking: 'high' }));
  // Without usage from Google the fallback image is the chosen size.
  close(nanoCost({ total_input_tokens: 100, total_output_tokens: 3800 }, { images: 1, imageSize: '4K' }), (100 * 1.5 + 3780 * 30 + 20 * 7.5) / 1e6);
  assert.equal(nanoCost(undefined, { ...measure, imageSize: '4K' }), nanoEstimate({ ...measure, imageSize: '4K' }));
  const base = gptImageEstimate(measure);
  assert.equal(base, .25 + (100 * 5 + 16000 * 8) / 1e6);
  assert.equal(gptImageEstimate({ ...measure, quality: 'medium', megapixels: 1024 * 1024 / 1e6 }), base);
  assert.ok(gptImageEstimate({ ...measure, quality: 'low' }) < base && base < gptImageEstimate({ ...measure, quality: 'high' }));
  close(gptImageEstimate({ ...measure, quality: 'high', megapixels: 8.2944 }) - base, .25 * 4 * 8.2944 / (1536 * 1024 / 1e6) - .25);
});

test('pending cards take the shape the run asked for and its generator uses', () => {
  const graph = { nodes: [prompt({ generator: nano, aspectRatio: '16:9', variants: 2 })], edges: [], groups: [] };
  const run = { id: 'r', nodeId: 'p', provider: nano, variants: 2, status: 'running', outputIds: [], settings: { requested: { aspectRatio: '16:9' }, applied: { aspectRatio: '16:9' } } };
  assert.deepEqual(expectedOutputs(graph, run), [{ type: 'image', aspect: 9 / 16 }, { type: 'image', aspect: 9 / 16 }]);
  const placeholders = runPlaceholders(graph, [run], 'page-1').nodes;
  assert.deepEqual(placeholders.map(node => [node.data.aspect, node.style.width, Math.round(node.style.height)]), [[9 / 16, 310, Math.round(310 * 9 / 16)], [9 / 16, 310, Math.round(310 * 9 / 16)]]);
  // A shape set aside (a Nano-only one on GPT Image) is not in `applied`, so the cards stay square.
  assert.deepEqual(expectedOutputs(graph, { ...run, settings: { requested: { aspectRatio: '8:1' }, applied: {} } })[0].aspect, 1);
  assert.deepEqual(expectedOutputs(graph, { ...run, settings: undefined })[0].aspect, 1);
});

test('the settings row is part of an image prompt’s predicted height', () => {
  assert.equal(textNodeSize(prompt({ text: '' })).height - textNodeSize({ type: 'text', data: { text: '', task: 'describe' } }).height, 28);
  assert.equal(textNodeSize({ type: 'text', data: { text: '', task: 'model3d' } }).height, 180);
});

test('agents set, clear and are refused settings like the board does', () => {
  const graph = { nodes: [prompt({ generator: nano }), prompt({ task: 'describe' })].map((node, index) => ({ ...node, id: index ? 'd' : 'p' })), edges: [], groups: [], runs: [] }, ctx = { graph, templates: [], revision: 'test' };
  const update = args => runBoardTool(toolByName.get('update_node'), { ...ctx, args: { nodeId: 'p', ...args } });
  const set = update({ aspectRatio: '16:9', imageSize: '4K', nanoThinking: 'high', gptQuality: 'low', background: 'transparent' }).graph.nodes[0].data;
  assert.deepEqual([set.aspectRatio, set.imageSize, set.nanoThinking, set.gptQuality, set.background], ['16:9', '4K', 'high', 'low', 'transparent']);
  const cleared = runBoardTool(toolByName.get('update_node'), { ...ctx, graph: { ...graph, nodes: [{ ...graph.nodes[0], data: set }, graph.nodes[1]] }, args: { nodeId: 'p', aspectRatio: 'default', imageSize: 'default', nanoThinking: 'medium', gptQuality: 'medium', background: 'normal' } }).graph.nodes[0].data;
  assert.deepEqual(Object.keys(cleared).filter(key => Object.hasOwn(generationFields, key)), []);
  assert.throws(() => runBoardTool(toolByName.get('update_node'), { ...ctx, args: { nodeId: 'd', aspectRatio: '1:1' } }), /aspectRatio applies to image prompts only/);
  const added = runBoardTool(toolByName.get('add_text_node'), { ...ctx, args: { text: 'Wide', generator: 'gpt-image', aspectRatio: '21:9', gptQuality: 'high' } });
  assert.deepEqual(['aspectRatio', 'gptQuality'].map(key => added.graph.nodes.at(-1).data[key]), ['21:9', 'high']);
  assert.throws(() => runBoardTool(toolByName.get('add_text_node'), { ...ctx, args: { text: 'x', describe: true, imageSize: '2K' } }), /imageSize applies to image prompts only/);
  const boardId = '12345678-1234-1234-1234-123456789abc', required = { add_text_node: { boardId, text: 'x' }, add_template_node: { boardId, templateId: boardId }, update_node: { boardId, nodeId: 'p' } };
  for (const [name, args] of Object.entries(required)) {
    const { inputSchema } = toolByName.get(name);
    for (const key of Object.keys(generationFields)) assert.ok(inputSchema.properties[key]?.enum?.length, `${name} ${key}`);
    assert.doesNotThrow(() => checkArgs({ ...args, aspectRatio: '21:9', imageSize: 'default', background: 'transparent' }, inputSchema));
    assert.throws(() => checkArgs({ ...args, aspectRatio: '7:3' }, inputSchema), /aspectRatio is invalid/);
  }
});

test('the chip names stored settings for the current generator, dims the ones it cannot use and prices a run', () => {
  const node = prompt({ generator: nano, aspectRatio: '3:4', imageSize: '2K', gptQuality: 'high', background: 'transparent', variants: 4 });
  const parts = settingParts(node, nano);
  assert.deepEqual(parts.map(part => [part.key, part.text, part.off]), [['aspectRatio', '3:4', false], ['imageSize', '2K', false], ['background', 'Transparent', true]]);
  assert.equal(partsText(parts), '3:4 · 2K · Transparent');
  assert.equal(partsText(settingParts(node, gpt)), '3:4 · 2K · High · Transparent');
  assert.deepEqual(settingParts(node, gpt).map(part => part.off), [false, false, false, false]);
  assert.equal(partsText(settingParts(prompt(), nano)), 'Default');
  assert.equal(appliedSummary({ applied: { aspectRatio: '16:9', imageSize: '4K', nanoThinking: 'minimal' } }), '16:9 · 4K · Fast');
  assert.equal(appliedSummary(undefined), ''); assert.equal(appliedSummary({ applied: { evil: '<b>' } }), '');
  const each = nanoEstimate({ promptLength: node.data.text.length, references: 2, imageSize: '2K' });
  assert.equal(costLine(node, nano, { references: 2 }), `≈ $${each.toFixed(2)} per image · 4 variants ≈ $${(each * 4).toFixed(2)}`);
  assert.equal(costLine(prompt(), codexGenerator), 'Uses your ChatGPT, not the team budget');
  setLanguage('uk');
  try {
    assert.equal(partsText(settingParts(prompt({ nanoThinking: 'high', background: 'transparent' }), nano)), 'Ретельне · Прозоре');
    // "Якість" is feminine, unlike the other levels that share these English words.
    assert.equal(partsText(settingParts(prompt({ gptQuality: 'high' }), gpt)), 'Висока');
    assert.equal(partsText(settingParts(prompt(), nano)), 'Типово');
    assert.match(costLine(node, nano, { references: 2 }), /^≈ \$[\d.]+ за зображення · 4 варіанти ≈ \$[\d.]+$/);
  } finally { setLanguage('en'); }
});

test('every reason a setting is not used, and the room’s reload message, read in Ukrainian', () => {
  for (const reason of [...Object.values(generationReasons), 'Reload the page to use generation settings.']) assert.ok(Object.hasOwn(uk, reason), reason);
  setLanguage('uk');
  try { assert.equal(t(generationReasons.nanoOnly), 'Такі пропорції підтримує лише Nano Banana.'); } finally { setLanguage('en'); }
});
