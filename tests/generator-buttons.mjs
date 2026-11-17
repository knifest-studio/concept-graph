import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import React from 'react';
import { clampVariants, generators, maxVariants, variantPresets } from '../graph.mjs';
import { t } from '../src/i18n.mjs';

// Compile the actual controls for SSR without a Vite server or any listening socket.
export async function loadGeneratorButtons() {
  const source = (await readFile(new URL('../src/GeneratorPicker.jsx', import.meta.url), 'utf8')).replace(/import .*?;\n/g, '');
  const { code } = await transformWithEsbuild(source, 'GeneratorPicker.jsx', { loader: 'jsx', format: 'cjs' }), module = { exports: {} };
  new Function('module', 'exports', 'React', 'generators', 'maxVariants', 'variantPresets', 'clampVariants', 't', code)(module, module.exports, React, generators, maxVariants, variantPresets, clampVariants, t);
  return module.exports;
}
