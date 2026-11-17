import { readBook, addSketchToBook, bookExists } from '../../lib/book-store.js';
import { addBookToSketch } from '../../lib/sketch-store.js';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing book id' });
  }

  if (req.method === 'GET') {
    const book = await readBook(id);
    if (!book) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json(book);
  }

  if (req.method === 'PUT') {
    const exists = await bookExists(id);
    if (!exists) return res.status(404).json({ error: 'Not found' });

    const { sketch } = req.body || {};
    if (!sketch || typeof sketch.id !== 'string') {
      return res.status(400).json({ error: 'Expected a { sketch: { id, name } } body' });
    }

    try {
      const book = await addSketchToBook(id, { id: sketch.id, name: sketch.name || '' });
      await addBookToSketch(sketch.id, id);
      return res.status(200).json(book);
    } catch (err) {
      console.error('Failed to add sketch to book', err);
      return res.status(500).json({ error: 'Could not update sketchbook' });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}
