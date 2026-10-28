// pg va PGlite xatolari (drizzle `cause` ichiga o'rashi mumkin).
function hasCode(err: unknown, code: string): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === code) return true;
  }
  return false;
}

export const isUniqueViolation = (err: unknown) => hasCode(err, '23505');
export const isForeignKeyViolation = (err: unknown) => hasCode(err, '23503');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);
