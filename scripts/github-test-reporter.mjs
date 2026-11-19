// node:test reporter for GitHub Actions: turns each failing test into an
// error annotation, so the run page and its public API name the test and the
// failure even for people who are not signed in to read the logs.
import path from 'node:path';

const escapeData = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = text => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { name, file, line, details } = event.data;
    const error = details?.error;
    if (details?.type === 'suite' || error?.failureType === 'subtestsFailed') continue;
    const cause = error?.cause ?? error;
    const where = cause?.stack?.split('\n').find(row => row.includes('/tests/'))?.trim();
    const message = [cause?.message ?? String(cause), where].filter(Boolean).join('\n');
    const location = file ? `file=${escapeProperty(path.relative(process.cwd(), file.replace(/^file:\/\//, '')))}${line ? `,line=${line}` : ''},` : '';
    yield `::error ${location}title=${escapeProperty(name)}::${escapeData(message.slice(0, 2000))}\n`;
  }
}
