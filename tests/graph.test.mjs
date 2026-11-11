import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInputs, validateGraph, validateTemplate, imageFormat, templatePalette, templateColor, nextTemplateColor, templateSnapshot, imageName, uniqueImageName, nameImageConnections, captionHeight } from '../graph.mjs';

const text = (id, value) => ({ id, type: 'text', position: { x: 0, y: 0 }, data: { text: value } });
const image = (id, label) => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png', label } });
const edge = (source, target) => ({ id: source + '-' + target, source, target });

test('image names use trimmed captions, file stems and a neutral fallback on old boards', () => {
  assert.equal(imageName({ data: { caption: '  Storm 3  ', label: 'clouds.png' } }), 'Storm 3');
  assert.equal(imageName(image('a', ' Canyon.final.JPG ')), 'Canyon.final');
  assert.equal(imageName({ data: { caption: '  ', label: 'Canyon.png' } }), 'Canyon');
  for (const label of [undefined, '', 'image', 'image.png', 'IMAGE.JPG', 'image (1).png', 'Pasted image', 'Reference image', 'Result 12']) assert.equal(imageName(image('a', label)), 'Image');
  assert.equal(imageName({ data: { caption: 'Image 1' } }), 'Image 1');
  assert.equal(imageName(image('long', 'x'.repeat(150) + '.png')), 'x'.repeat(120));
});

test('new image names are unique across pages and stay within 120 characters including suffixes', () => {
  const nodes = [image('one', 'Image 1'), { ...image('three', 'Image 3'), page: 'other' }, image('canyon', 'Canyon.png'), image('canyon2', 'Canyon 2.png')];
  assert.equal(uniqueImageName(nodes, ''), 'Image 2');
  assert.equal(uniqueImageName(nodes, ' Image '), 'Image 2');
  assert.equal(uniqueImageName(nodes, 'Canyon'), 'Canyon 3');
  assert.equal(uniqueImageName(nodes, 'Canyon', 'canyon'), 'Canyon');
  assert.equal(uniqueImageName(nodes, 'Storm 3'), 'Storm 3');
  // A taken generic name moves to the next free number instead of growing a second suffix.
  assert.equal(uniqueImageName(nodes, 'Image 1'), 'Image 2');
  assert.equal(uniqueImageName(nodes, 'Image 7'), 'Image 7');
  const long = 'x'.repeat(120), used = [{ ...image('long', ''), data: { caption: long } }];
  assert.equal(uniqueImageName([], long + 'extra'), long);
  assert.equal(uniqueImageName(used, long), 'x'.repeat(118) + ' 2');
  used.push({ ...image('long2', ''), data: { caption: 'x'.repeat(118) + ' 2' } });
  assert.equal(uniqueImageName(used, long), 'x'.repeat(118) + ' 3');
});

test('connecting legacy images stores names and resolves target collisions in one immutable update', () => {
  const named = { ...image('named', 'Result 1'), data: { ...image('named').data, caption: 'Canyon' } };
  const duplicate = { ...named, id: 'duplicate' }, legacy = image('legacy', 'image.png');
  const nodes = [text('p', 'Use Canyon'), named, duplicate, legacy], original = structuredClone(nodes), edges = [edge('named', 'p')];
  const added = [edge('duplicate', 'p'), edge('legacy', 'p')];
  const result = nameImageConnections(nodes, edges, added);
  assert.deepEqual(result.filter(node => node.type === 'image').map(imageName), ['Canyon', 'Canyon 2', 'Image 1']);
  assert.deepEqual(nodes, original);
  assert.equal(result[1], named);
  assert.equal(nameImageConnections(result, [...edges, ...added], [edge('named', 'p')]), result);
  const batch = nameImageConnections([text('p', 'Describe'), image('a', 'image.png'), image('b', 'image.png')], [], [edge('a', 'p'), edge('b', 'p')]);
  assert.deepEqual(batch.slice(1).map(node => node.data.caption), ['Image 1', 'Image 2']);
});

test('attachment ordinals never impersonate board names, including the real Image 1 collision', () => {
  const nodes = [image('first', 'image.png'), { ...image('second', 'Result 1'), data: { ...image('second').data, caption: 'Image 1' } }, text('p', 'Take the clouds from “Image 1”')];
  const graph = { nodes, edges: [edge('first', 'p'), edge('second', 'p')] };
  const { prompt, snapshot } = collectInputs(graph, 'p');
  assert.match(prompt, /Attachment 1: “Image”\nAttachment 2: “Image 1”/);
  assert.doesNotMatch(prompt, /Image 1:|Image 2:|image\.png/);
  assert.match(prompt, /Take the clouds from “Image 1”/);
  assert.deepEqual(snapshot, nodes);
  graph.nodes[2].data.task = 'describe';
  assert.match(collectInputs(graph, 'p').prompt, /Attachment 1: “Image”\nAttachment 2: “Image 1”/);
});

test('every expanded image reserves name space, including unnamed legacy images', () => {
  const node = image('a', 'image.png');
  assert.equal(captionHeight(node), 24);
  assert.equal(captionHeight({ ...node, data: { ...node.data, caption: '' } }), 24);
  assert.equal(captionHeight({ ...node, data: { ...node.data, caption: 'Front' } }), 24);
  assert.equal(captionHeight({ ...node, data: { ...node.data, collapsed: true } }), 0);
  assert.equal(captionHeight(text('p', 'Generate')), 0);
});

test('template colours validate, balance the fixed palette and survive snapshots independently of the library', () => {
  const template = { id: 'type', name: 'Views', instructions: 'Front', assets: [] };
  assert.deepEqual(validateTemplate(template), { name: 'Views', instructions: 'Front', assets: [] });
  assert.equal(templateColor(template), templateColor({ name: template.name }));
  assert.ok(templatePalette.includes(templateColor(template)));
  assert.equal(nextTemplateColor([]), templatePalette[0]);
  assert.equal(nextTemplateColor([{ ...template, color: templatePalette[0] }]), templatePalette[1]);
  assert.equal(nextTemplateColor(templatePalette.map(color => ({ ...template, color }))), templatePalette[0]);
  for (const color of templatePalette) assert.equal(validateTemplate({ ...template, color }).color, color);
  for (const color of [null, 42, '', 'red', '#123456', 'url(javascript:bad)']) assert.throws(() => validateTemplate({ ...template, color }), /template/);
  const snapshot = templateSnapshot(template);
  template.color = templatePalette.find(color => color !== snapshot.color); template.name = 'Changed';
  assert.equal(snapshot.name, 'Views'); assert.notEqual(snapshot.color, template.color);
  const node = text('p', 'Prompt'); node.data.template = snapshot;
  assert.doesNotThrow(() => validateGraph({ nodes: [node], edges: [] }));
});

test('node timestamps are optional for old boards and validated when present', () => {
  const node = text('p', 'Prompt'), graph = { nodes: [node], edges: [] };
  assert.doesNotThrow(() => validateGraph(graph));
  node.data.createdAt = new Date().toISOString(); assert.doesNotThrow(() => validateGraph(graph));
  for (const value of ['not-a-date', 123, null]) { node.data.createdAt = value; assert.throws(() => validateGraph(graph), /creation time/); }
});

test('a run gets only directly connected nodes, once and in order, not their ancestors', () => {
  const graph = { nodes: [text('style', 'Clay render'), text('original', 'Orange helmet'), image('one', 'Original robot'), image('two', 'Palette'), text('edit', 'Make the helmet blue'), text('unrelated', 'Do not include me')], edges: [edge('style', 'original'), edge('original', 'one'), edge('one', 'edit'), edge('style', 'edit'), edge('two', 'edit')] };
  const result = collectInputs(graph, 'edit');
  assert.deepEqual(result.snapshot.map(n => n.id), ['one', 'style', 'two', 'edit']);
  assert.equal(result.images.length, 2);
  assert.equal(result.prompt.split('Clay render').length - 1, 1);
  assert.ok(!result.prompt.includes('Do not include me'));
  // The prompt that generated the attached image is not resent.
  assert.ok(!result.prompt.includes('Orange helmet'));
  assert.ok(result.prompt.indexOf('FINAL REQUEST') > result.prompt.indexOf('Clay render'));
  graph.nodes.find(n => n.id === 'edit').data.text = 'Changed later';
  assert.equal(result.target.data.text, 'Make the helmet blue');
  assert.equal(result.snapshot.at(-1).data.text, 'Make the helmet blue');
});

test('reject cycles, dangling connections, duplicate IDs, and blank prompts', () => {
  assert.throws(() => validateGraph({ nodes: [text('a', 'A'), text('b', 'B')], edges: [edge('a', 'b'), edge('b', 'a')] }), /loop/);
  assert.throws(() => validateGraph({ nodes: [text('a', 'A')], edges: [edge('a', 'missing')] }), /connection/);
  assert.throws(() => validateGraph({ nodes: [text('a', 'A'), text('a', 'B')], edges: [] }), /duplicate/);
  assert.throws(() => collectInputs({ nodes: [text('a', '  ')], edges: [] }, 'a'), /prompt/);
});

test('asset references cannot escape the asset directory', () => {
  const node = image('a', 'Bad'); node.data.asset = '../../auth.json';
  assert.throws(() => validateGraph({ nodes: [node], edges: [] }), /asset/);
});

test('uploads are recognized from bytes, never trusted from file names', () => {
  assert.equal(imageFormat(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
  assert.equal(imageFormat(Buffer.from([255, 216, 255, 0])), 'jpg');
  assert.throws(() => imageFormat(Buffer.from('<script>alert(1)</script>')), /PNG/);
});

test('custom nodes add their saved instructions and reference images to the connected input snapshot', () => {
  const asset = '12345678-1234-1234-1234-123456789abc.png';
  const custom = text('custom', '');
  custom.data.template = { name: 'Multiview', instructions: 'Show front, side, and back', assets: [asset] };
  const graph = { nodes: [image('reference', 'Character'), custom], edges: [edge('reference', 'custom')] };
  const result = collectInputs(graph, 'custom');
  assert.deepEqual(result.images, [asset, asset]);
  assert.match(result.prompt, /Show front, side, and back/);
  assert.match(result.prompt, /Attachment 2: “Multiview reference 1”/);
  custom.data.template.instructions = 'Changed after run';
  assert.equal(result.target.data.template.instructions, 'Show front, side, and back');
  assert.equal(result.snapshot[1].data.template.instructions, 'Show front, side, and back');
});

test('custom reference limits include connected images and malformed hidden metadata is rejected', () => {
  const asset = '12345678-1234-1234-1234-123456789abc.png';
  const custom = text('custom', 'Make a variation');
  custom.data.template = { name: 'Preset', instructions: 'Use the references', assets: Array(10).fill(asset) };
  const graph = { nodes: [image('reference', 'Character'), custom], edges: [edge('reference', 'custom')] };
  assert.throws(() => collectInputs(graph, 'custom'), /at most 10/);
  custom.data.template.assets = ['../../auth.json'];
  assert.throws(() => validateGraph(graph), /custom node template/);
  custom.data.template.assets = [];
  custom.data.template.instructions = '';
  custom.data.text = '';
  assert.throws(() => collectInputs(graph, 'custom'), /prompt/);
});

test('optional caption settings are validated and captions describe connected image inputs', () => {
  const input = image('reference', 'Original label'), prompt = text('prompt', 'Make a variation');
  input.data.caption = 'Front view'; prompt.data.labelOutputs = true;
  const graph = { nodes: [input, prompt], edges: [edge('reference', 'prompt')] };
  const result = collectInputs(graph, 'prompt');
  assert.match(result.prompt, /Attachment 1: “Front view”/);
  assert.equal(result.target.data.labelOutputs, true);
  input.data.caption = 42; assert.throws(() => validateGraph(graph), /caption/);
  input.data.caption = 'x'.repeat(121); assert.throws(() => validateGraph(graph), /caption/);
  delete input.data.caption; prompt.data.labelOutputs = 'yes'; assert.throws(() => validateGraph(graph), /caption setting/);
  delete prompt.data.labelOutputs; assert.match(collectInputs(graph, 'prompt').prompt, /Attachment 1: “Original label”/);
  const template = { name: 'Views', instructions: 'Describe views', assets: [] };
  assert.deepEqual(validateTemplate({ ...template, labelOutputs: true }), { ...template, labelOutputs: true });
  assert.deepEqual(validateTemplate({ ...template, labelOutputs: false }), template);
  assert.throws(() => validateTemplate({ ...template, labelOutputs: 'yes' }), /template/);
});
