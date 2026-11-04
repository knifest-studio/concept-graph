import React from 'react';
import { matchingTemplateId } from './node-template.mjs';
import { templateColor } from '../graph.mjs';
import './node-template-picker.css';

export function NodeTemplatePicker({ id, template, templates, switchTemplate, viewTemplate, disabled = false }) {
  const match = matchingTemplateId(template, templates);
  const value = template ? (match || '__snapshot') : '';
  return <div className={`node-template-picker nodrag nopan ${template ? 'custom-template' : 'plain-template'}`} style={template ? { '--template-color': templateColor(template) } : undefined}>
    <select aria-label="Node type" data-tooltip={disabled ? undefined : 'Choose text or a saved custom node'} disabled={disabled} value={value} onChange={event => switchTemplate(id, event.target.value || null)}>
      <option value="">Text prompt</option>
      {template && !match && <option value="__snapshot" disabled>{template.name} (saved)</option>}
      {templates.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select>
    {template && <button type="button" className="node-template-info" aria-label={`View instructions and references for ${template.name}`} data-tooltip="View saved instructions and references" onClick={() => viewTemplate(template)}>i</button>}
  </div>;
}
