import { put, get, del, list } from '@vercel/blob';
import { randomBytes } from 'crypto';
import { resolveUniqueId } from './slug.js';

const PREFIX = 'sketches/';

export function generateId() {
  return randomBytes(8).toString('base64url');
}

function metaPathFor(sketchId) {
  return `${PREFIX}${sketchId}/meta.json`;
}

function objectPathFor(sketchId, objectId) {
  return `${PREFIX}${sketchId}/objects/${objectId}.json`;
}

function objectsPrefixFor(sketchId) {
  return `${PREFIX}${sketchId}/objects/`;
}

async function readJsonBlob(pathname) {
  const result = await get(pathname, { access: 'private' });
  if (!result || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

// a meta.json read can briefly miss a write that just happened moments ago in a prior request —
// retry a few times before concluding it's genuinely missing
async function readMetaWithRetry(sketchId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const meta = await readJsonBlob(metaPathFor(sketchId));
    if (meta) return meta;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function writeMeta(sketchId, meta) {
  await put(metaPathFor(sketchId), JSON.stringify(meta), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function sketchExists(sketchId) {
  const result = await get(metaPathFor(sketchId), { access: 'private' });
  return !!result;
}

export async function createSketch(nodes, { name, slug } = {}) {
  const sketchId = await resolveUniqueId(slug, sketchExists, generateId);
  await writeMeta(sketchId, { version: 1, createdAt: Date.now(), name: name || '', bookIds: [] });
  await Promise.all(nodes.map((node) => writeObject(sketchId, node)));
  return sketchId;
}

export async function readSketch(sketchId) {
  const meta = await readJsonBlob(metaPathFor(sketchId));
  const { blobs } = await list({ prefix: objectsPrefixFor(sketchId) });
  const nodes = await Promise.all(blobs.map((blob) => readJsonBlob(blob.pathname)));
  return {
    version: 1,
    name: (meta && meta.name) || '',
    bookIds: (meta && meta.bookIds) || [],
    nodes: nodes.filter(Boolean),
  };
}

export async function renameSketch(sketchId, name) {
  const meta = await readMetaWithRetry(sketchId);
  if (!meta) throw new Error('Sketch not found');
  await writeMeta(sketchId, { ...meta, name });
}

export async function addBookToSketch(sketchId, bookId) {
  const meta = await readMetaWithRetry(sketchId);
  if (!meta) throw new Error('Sketch not found');
  const bookIds = meta.bookIds || [];
  if (!bookIds.includes(bookId)) bookIds.push(bookId);
  await writeMeta(sketchId, { ...meta, bookIds });
}

export async function writeObject(sketchId, node) {
  const body = JSON.stringify(node);
  await put(objectPathFor(sketchId, node.id), body, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function deleteObject(sketchId, objectId) {
  await del(objectPathFor(sketchId, objectId));
}
