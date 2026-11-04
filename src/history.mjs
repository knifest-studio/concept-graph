import { cleanGroups } from './canvas.mjs';
import { cleanSections } from './sections.mjs';

// Undo on local boards keeps JSON snapshots of the board's content without editor-only fields (selection, measurements).
export const cleanNodes = nodes => nodes.map(({ id, type, position, data, page, z }) => ({ id, type, position, data, ...(page === undefined ? {} : { page }), ...(z === undefined ? {} : { z }) }));
export const cleanEdges = edges => edges.map(({ id, source, target }) => ({ id, source, target }));
const content = ({ nodes, edges, groups, pages, sections }) => ({ nodes: cleanNodes(nodes), edges: cleanEdges(edges), groups: cleanGroups(groups), pages, sections: cleanSections(sections) });
export const historySignature = graph => JSON.stringify(content(graph));
// The same signature for a parsed snapshot, whose lists are already clean.
export const snapshotSignature = snapshot => JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges, groups: snapshot.groups, pages: snapshot.pages, sections: snapshot.sections });
export const captureHistory = (graph, { remoteGroupVersion = 0, remoteCaptionVersion = 0, activeRunIds = [] } = {}) => JSON.stringify({ ...content(graph), capturedAt: new Date().toISOString(), remoteGroupVersion, remoteCaptionVersion, activeRunIds });
