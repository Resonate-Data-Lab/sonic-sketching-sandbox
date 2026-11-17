export function slugify(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// turns a user-desired name into a unique, URL-safe id — appending -2, -3, etc.
// if the plain slug is already taken, falling back to a random id if no
// usable name was given at all
export async function resolveUniqueId(desired, existsFn, fallbackGenerator) {
  const base = desired && slugify(desired);
  if (!base) return fallbackGenerator();

  let candidate = base;
  let suffix = 1;
  while (await existsFn(candidate)) {
    suffix++;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
