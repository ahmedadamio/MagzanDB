// Port of pglite-sync/src/subscriptionState.ts — subscription metadata tables.
const subscriptionTableName = `subscriptions_metadata`

/**
 * Get the subscription state for a given key.
 */
export async function getSubscriptionState({
  pg,
  metadataSchema,
  subscriptionKey,
}) {
  const result = await pg.query(
    `
      SELECT key, shape_metadata, last_lsn
      FROM ${subscriptionMetadataTableName(metadataSchema)}
      WHERE key = $1
    `,
    [subscriptionKey],
  )

  if (result.rows.length === 0) {
    return null
  } else if (result.rows.length > 1) {
    throw new Error(`Multiple subscriptions found for key: ${subscriptionKey}`)
  }

  const res = result.rows[0]

  if (typeof res.last_lsn === 'string') {
    return {
      ...res,
      last_lsn: BigInt(res.last_lsn),
    }
  } else {
    throw new Error(`Invalid last_lsn type: ${typeof res.last_lsn}`)
  }
}

/**
 * Update the subscription state for a given key.
 */
export async function updateSubscriptionState({
  pg,
  metadataSchema,
  subscriptionKey,
  shapeMetadata,
  lastLsn,
  debug,
}) {
  if (debug) {
    console.log(
      'updating subscription state',
      subscriptionKey,
      shapeMetadata,
      lastLsn,
    )
  }
  await pg.query(
    `
      INSERT INTO ${subscriptionMetadataTableName(metadataSchema)}
        (key, shape_metadata, last_lsn)
      VALUES
        ($1, $2, $3)
      ON CONFLICT(key)
      DO UPDATE SET
        shape_metadata = EXCLUDED.shape_metadata,
        last_lsn = EXCLUDED.last_lsn;
    `,
    [subscriptionKey, shapeMetadata, lastLsn.toString()],
  )
}

/**
 * Delete the subscription state for a given key.
 */
export async function deleteSubscriptionState({
  pg,
  metadataSchema,
  subscriptionKey,
}) {
  await pg.query(
    `DELETE FROM ${subscriptionMetadataTableName(metadataSchema)} WHERE key = $1`,
    [subscriptionKey],
  )
}

/**
 * Migrate the subscription metadata tables.
 */
export async function migrateSubscriptionMetadataTables({
  pg,
  metadataSchema,
}) {
  await pg.exec(
    `
      SET ${metadataSchema}.syncing = false;
      CREATE SCHEMA IF NOT EXISTS "${metadataSchema}";
      CREATE TABLE IF NOT EXISTS ${subscriptionMetadataTableName(metadataSchema)} (
        key TEXT PRIMARY KEY,
        shape_metadata JSONB NOT NULL,
        last_lsn TEXT NOT NULL
      );
    `,
  )
}

function subscriptionMetadataTableName(metadataSchema) {
  return `"${metadataSchema}"."${subscriptionTableName}"`
}
