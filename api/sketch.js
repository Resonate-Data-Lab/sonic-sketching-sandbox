import { generateId, writeSketch } from '../lib/sketch-store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body;
  if (!data || !Array.isArray(data.nodes)) {
    return res.status(400).json({ error: 'Expected a { nodes: [...] } sketch document' });
  }

  const id = generateId();
  try {
    await writeSketch(id, data);
    return res.status(201).json({ id });
  } catch (err) {
    console.error('Failed to save sketch', err);
    return res.status(500).json({ error: 'Could not save sketch' });
  }
}
