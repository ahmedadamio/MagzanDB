// Port of pglite-repl/src/utils.ts
import { describe } from 'psql-describe'

export async function runQuery(query, pg) {
  if (query.trim().toLowerCase().startsWith('\\')) {
    return runDescribe(query, pg)
  }
  const start = performance.now()
  try {
    const result = await pg.exec(query, {
      rowMode: 'array',
    })
    const elapsed = performance.now() - start
    return {
      query,
      results: result,
      time: elapsed,
    }
  } catch (err) {
    return {
      query,
      error: err.message,
      time: performance.now() - start,
    }
  }
}

export async function runDescribe(query, pg) {
  const start = performance.now()
  let out
  let ret
  const { promise, cancel: _cancel } = describe(
    query,
    'postgres',
    async (sql) => {
      ret = (await pg.exec(sql, { rowMode: 'array' }))[0]
      return {
        rows: ret.rows,
        fields: ret.fields,
        rowCount: ret.rows.length,
      }
    },
    (output) => {
      out = output
    },
  )
  await promise
  const elapsed = performance.now() - start

  if (!out) {
    return {
      query,
      error: 'No output',
      time: elapsed,
    }
  } else if (typeof out === 'string') {
    if (out.startsWith('ERROR:')) {
      return {
        query,
        error: out,
        time: elapsed,
      }
    } else {
      return {
        query,
        text: out,
        time: elapsed,
      }
    }
  } else {
    return {
      query,
      text: out.title,
      results: [ret],
      time: elapsed,
    }
  }
}

export async function getSchema(pg) {
  const ret = await pg.query(`
    SELECT 
      table_schema AS schema,
      table_name AS table,
      array_agg(column_name) AS columns
    FROM 
      information_schema.columns
    GROUP BY 
      table_schema, table_name
    ORDER BY 
      table_schema, table_name;
  `)
  const schema = {}
  for (const row of ret.rows) {
    schema[`${row.schema}.${row.table}`] = Array.isArray(row.columns)
      ? row.columns
      : row.columns.slice(1, -1).split(',')
  }
  return schema
}
