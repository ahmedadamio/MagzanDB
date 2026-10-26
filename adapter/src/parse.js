// Port of pglite/src/parse.ts — result parsing helpers operating on
// BackendMessage objects (as returned by execProtocolRaw).
import { parseType } from './types.js'

/**
 * This function is used to parse the results of either a simple or extended query.
 * https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-SIMPLE-QUERY
 */
export function parseResults(messages, defaultParsers, options, blob) {
  const resultSets = []
  let currentResultSet = { rows: [], fields: [] }
  let affectedRows = 0
  const parsers = { ...defaultParsers, ...options?.parsers }

  messages.forEach((message) => {
    switch (message.name) {
      case 'rowDescription': {
        currentResultSet.fields = message.fields.map((field) => ({
          name: field.name,
          dataTypeID: field.dataTypeID,
        }))
        break
      }
      case 'dataRow': {
        if (!currentResultSet) break
        if (options?.rowMode === 'array') {
          currentResultSet.rows.push(
            message.fields.map((field, i) =>
              parseType(field, currentResultSet.fields[i].dataTypeID, parsers),
            ),
          )
        } else {
          // rowMode === "object"
          currentResultSet.rows.push(
            Object.fromEntries(
              message.fields.map((field, i) => [
                currentResultSet.fields[i].name,
                parseType(
                  field,
                  currentResultSet.fields[i].dataTypeID,
                  parsers,
                ),
              ]),
            ),
          )
        }
        break
      }
      case 'commandComplete': {
        // A command tag that carries a row count ends in it ("SELECT 2",
        // "UPDATE 3", "INSERT 0 5"); all other tags end in a word
        // ("CREATE TABLE").
        const parts = message.text.split(' ')
        const command = parts[0]
        const rowCount = parseInt(parts[parts.length - 1], 10)

        switch (command) {
          case 'INSERT':
          case 'UPDATE':
          case 'DELETE':
          case 'COPY':
          case 'MERGE':
            affectedRows += rowCount
            break
        }

        const result = {
          ...currentResultSet,
          command,
          affectedRows,
        }

        if (!Number.isNaN(rowCount)) {
          result.rowCount = rowCount
        }

        if (blob) {
          result.blob = blob
        }

        resultSets.push(result)

        currentResultSet = { rows: [], fields: [] }
        break
      }
    }
  })

  if (resultSets.length === 0) {
    resultSets.push({
      affectedRows: 0,
      rows: [],
      fields: [],
    })
  }

  return resultSets
}

/** Get the dataTypeIDs from a list of messages, if it's available. */
export function parseDescribeStatementResults(messages) {
  const message = messages.find(
    (msg) => msg.name === 'parameterDescription',
  )
  return message ? message.dataTypeIDs : []
}
