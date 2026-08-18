import { db } from './driver.ts';

/**
 * `record.value` is a Postgres `money` column in the existing production
 * database. `money` is locale-sensitive and the driver returns it as a
 * formatted string, so every read and write has to be cast explicitly.
 *
 * Rather than assume, we introspect the column once at boot and build the right
 * SQL fragments. That means the exact same code works before and after someone
 * runs the optional `numeric` migration.
 */

export type ValueColumnKind = 'money' | 'numeric' | 'text';

interface SchemaInfo {
  valueKind: ValueColumnKind;
  hasAccountId: boolean;
  hasUpdatedAt: boolean;
  hasPending: boolean;
  hasId: boolean;
}

let cached: SchemaInfo | null = null;

export async function loadSchemaInfo(force = false): Promise<SchemaInfo> {
  if (cached && !force) return cached;

  const { rows } = await db().query<{ column_name: string; udt_name: string }>(
    `SELECT column_name, udt_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'record'`
  );

  const byName = new Map(rows.map((row) => [row.column_name, row.udt_name]));
  const valueType = (byName.get('value') ?? 'money').toLowerCase();

  let valueKind: ValueColumnKind;
  if (valueType === 'money') valueKind = 'money';
  else if (['numeric', 'int2', 'int4', 'int8', 'float4', 'float8', 'decimal'].includes(valueType)) {
    valueKind = 'numeric';
  } else valueKind = 'text';

  cached = {
    valueKind,
    hasAccountId: byName.has('account_id'),
    hasUpdatedAt: byName.has('updated_at'),
    hasPending: byName.has('pending'),
    hasId: byName.has('id'),
  };

  return cached;
}

/**
 * SQL predicate that isolates realised (non-pending) movements. Falls back to
 * "everything counts" when the column has not been added yet, which keeps the
 * API correct against an un-migrated database.
 */
export function settledSql(alias = 'r'): string {
  return schemaInfo().hasPending ? `COALESCE(${alias}.pending, FALSE) = FALSE` : 'TRUE';
}

export function schemaInfo(): SchemaInfo {
  if (!cached) {
    throw new Error('loadSchemaInfo() must run before schemaInfo()');
  }
  return cached;
}

/**
 * SQL expression that reads `value` as a float8, whatever the column type is.
 * `column` should already be qualified, e.g. `r.value`.
 */
export function readValueSql(column = 'r.value'): string {
  switch (schemaInfo().valueKind) {
    case 'money':
      return `(${column}::numeric)::float8`;
    case 'numeric':
      return `(${column})::float8`;
    case 'text':
      // Strip currency symbols and thousands separators before casting.
      return `(NULLIF(regexp_replace(${column}, '[^0-9.\\-]', '', 'g'), ''))::float8`;
  }
}

/**
 * SQL expression that writes a JS number into `value`.
 * `placeholder` is the bind parameter, e.g. `$5`.
 */
export function writeValueSql(placeholder: string): string {
  switch (schemaInfo().valueKind) {
    case 'money':
      // Explicit numeric cast avoids `money`'s locale-dependent text parsing.
      return `CAST(${placeholder}::numeric AS money)`;
    case 'numeric':
      return `${placeholder}::numeric`;
    case 'text':
      return `${placeholder}::text`;
  }
}
