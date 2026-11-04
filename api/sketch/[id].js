import { readSketch, writeSketch, findSketchBlob } from '../../lib/sketch-store.js';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing sketch id' });
  }

  if (req.method === 'GET') {
    const data = await readSketch(id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json(data);
  }

  if (req.method === 'PUT') {
    const existing = await findSketchBlob(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const data = req.body;
    if (!data || !Array.isArray(data.nodes)) {
      return res.status(400).json({ error: 'Expected a { nodes: [...] } sketch document' });
    }

    try {
      await writeSketch(id, data);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Failed to update sketch', err);
      return res.status(500).json({ error: 'Could not update sketch' });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}
