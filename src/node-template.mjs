import { validateTemplate, templateColor, templateSnapshot } from '../graph.mjs';

export function templateFromNode(node, nodes, edges) {
  if (node?.type !== 'text') throw new Error('Only text nodes can use a custom node.');
  const references = edges.filter(edge => edge.target === node.id).map(edge => nodes.find(item => item.id === edge.source)).filter(item => item?.type === 'image');
  return validateTemplate({
    name: node.data.template?.name || node.data.text.trim().split('\n')[0].slice(0, 80) || 'Custom node',
    instructions: [node.data.template?.instructions, node.data.text].filter(value => value?.trim()).join('\n\n'),
    assets: [...new Set([...(node.data.template?.assets || []), ...references.map(item => item.data.asset)])],
    ...(node.data.labelOutputs === true ? { labelOutputs: true } : {}),
  });
}

// Preserve the prompt and connections while changing only its reusable instructions.
export function switchNodeTemplate(node, template) {
  if (!node || node.type !== 'text') throw new Error('Only text nodes can use a custom node.');
  const data = { ...node.data };
  if (template) data.template = templateSnapshot(template);
  else delete data.template;
  return { ...node, data };
}

export function matchingTemplateId(snapshot, templates) {
  if (!snapshot) return '';
  const match = templates.find(value => value.name === snapshot.name && value.instructions === snapshot.instructions
    && value.assets.length === snapshot.assets.length && value.assets.every((asset, index) => asset === snapshot.assets[index]) && templateColor(value) === templateColor(snapshot));
  return match?.id || null;
}
