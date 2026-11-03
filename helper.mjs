#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

process.env.CONCEPT_GRAPH_DATA ||= path.join(homedir(), '.concept-graph');
process.env.PORT ||= '43170';
process.env.CONCEPT_GRAPH_SITE ||= 'https://concept-graph-local.knifest.chatgpt.site';
process.env.CONCEPT_GRAPH_HELPER_TOKEN = randomBytes(32).toString('hex');
console.log(`Concept Graph connection code: ${process.env.CONCEPT_GRAPH_HELPER_TOKEN}`);
console.log(`Paste this code into ${process.env.CONCEPT_GRAPH_SITE}. Keep this terminal open.`);
// The Mac helper app holds our stdin open; EOF means the app is gone, so stop instead of keeping the port.
if (process.env.CONCEPT_GRAPH_EXIT_WITH_PARENT === '1') process.stdin.on('end', () => process.exit(0)).resume();
await import('./server.mjs');
