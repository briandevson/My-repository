/** Character names: 2-12 characters, letters, digits and underscores. */
export function normaliseName(name) {
  const clean = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  return /^[a-z0-9_]{2,12}$/.test(clean) ? clean : null;
}

export function displayName(name) {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
