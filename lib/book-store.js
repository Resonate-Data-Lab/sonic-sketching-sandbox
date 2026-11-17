import { put, get } from '@vercel/blob';
import { generateId } from './sketch-store.js';
import { resolveUniqueId } from './slug.js';

const PREFIX = 'books/';

function metaPathFor(bookId) {
  return `${PREFIX}${bookId}/meta.json`;
}

async function readJsonBlob(pathname) {
  const result = await get(pathname, { access: 'private' });
  if (!result || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

async function writeMeta(bookId, meta) {
  await put(metaPathFor(bookId), JSON.stringify(meta), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function bookExists(bookId) {
  const result = await get(metaPathFor(bookId), { access: 'private' });
  return !!result;
}

// sketch: { id, name } — the seed member this book is created with
export async function createBook({ name, slug, sketch }) {
  const bookId = await resolveUniqueId(slug, bookExists, generateId);
  await writeMeta(bookId, { version: 1, name: name || '', sketches: [sketch] });
  return bookId;
}

export async function readBook(bookId) {
  return readJsonBlob(metaPathFor(bookId));
}

export async function addSketchToBook(bookId, sketch) {
  const book = await readJsonBlob(metaPathFor(bookId));
  if (!book) throw new Error('Book not found');
  book.sketches.push(sketch);
  await writeMeta(bookId, book);
  return book;
}

export async function renameSketchInBook(bookId, sketchId, name) {
  const book = await readJsonBlob(metaPathFor(bookId));
  if (!book) throw new Error('Book not found');
  const entry = book.sketches.find((s) => s.id === sketchId);
  if (entry) entry.name = name;
  await writeMeta(bookId, book);
  return book;
}
