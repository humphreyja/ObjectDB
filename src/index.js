const indexes = {
  hasMany: {},
  belongsTo: {},
  indexes: {},
  tables: {},
};

export class ValidationError extends Error {
  constructor(message, table, attribute) {
    super(message); // (1)
    this.table = table;
    this.attribute = attribute;
    this.name = 'ValidationError'; // (2)
  }
}


function validateRequired(record, attribute, table, attributeDefinition) {
  const failedAttribute = attribute;
  // Not required
  if (typeof attributeDefinition.required === 'function') {
    if (!attributeDefinition.required(record, attribute)) return;
  } else if (!attributeDefinition.required) return;

  // Has a value
  if (record[attribute] !== undefined && record[attribute] !== null) return;


  // if (attributeDefinition.relationship) {
  //   failedAttribute = attributeDefinition.relationship;
  // }

  throw new ValidationError(`ObjectDB: Upsert failed!\nAttribute "${table}.${failedAttribute}" is required.`, table, attribute);
}

export default class ObjectDB {
  static getNewRecord(table) {
    const newRecord = {};
    const tableDefinition = indexes.tables[table];
    Object.keys(tableDefinition.attributes).forEach((attribute) => {
      const attributeDefinition = tableDefinition.attributes[attribute];
      if (attributeDefinition.type === 'type') {
        newRecord[attribute] = attributeDefinition.defaultValue;
        newRecord[attribute] = attributeDefinition.cast(newRecord[attribute]);
      }
    });
    return newRecord;
  }

  static commit(initialData, changeset, options = {}) {
    if (options.rebuildIndexes === 'all') {
      console.log('rebuild indexes!');
      ObjectDB.rebuildIndexes(initialData);
    } else if (options.rebuildIndexes !== 'skip') {
      console.log('adjust indexes');
      ObjectDB.rebuildIndexes(initialData, changeset);
    }

    const data = { ...initialData };

    Object.keys(changeset).forEach(table => (
      Object.keys(changeset[table]).forEach((id) => {
        if (changeset[table][id] === 'DELETE') {
          delete data[table][id];
        } else {
          data[table] = {
            ...data[table],
            [id]: changeset[table][id],
          };
        }
      })
    ));

    return data;
  }

  // Assign has many references to the record
  static assignReferences(table, record) {
    if (!record) return record;
    const recordWithIndexes = { ...record };

    const dataTypeReferences = indexes.hasMany[table] || {};
    Object.keys(dataTypeReferences).forEach((attribute) => {
      const { primaryKey, data } = dataTypeReferences[attribute];
      recordWithIndexes[attribute] = Object.values(data[record[primaryKey]] || {});
    });
    return recordWithIndexes;
  }

  static upsert(initialTable, initialRecord, data = {}) {
    const changeset = {};

    const internalGenerateChangeset = (table, record) => {
      if (!record) return null;
      if (typeof record !== 'object') return null;

      const tableDefinition = indexes.tables[table];

      if (!changeset[table]) changeset[table] = {};
      let recordId = record.id;

      Object.keys(tableDefinition.unique).forEach((attribute) => {
        if (record[attribute]) {
          const attributeDefinition = tableDefinition.unique[attribute];
          // unique index
          if (!recordId) {
            recordId = ObjectDB.searchIndex(attributeDefinition.name, record[attribute]);
          }
        }
      });

      // Record is new
      let preparedRecord = { ...record, id: recordId };
      let isNew = false;
      preparedRecord = tableDefinition.hooks.beforeChange.reduce(
        (result, hook) => hook(result, data) || result, preparedRecord,
      );

      if (!recordId) {
        isNew = true;
        preparedRecord = tableDefinition.hooks.beforeCreate.reduce(
          (result, hook) => hook(result, data) || result, preparedRecord,
        );

        recordId = ObjectDB.nextPrimaryKey(table);
        preparedRecord.id = recordId;
      } else {
        preparedRecord = tableDefinition.hooks.beforeUpdate.reduce(
          (result, hook) => hook(result, data) || result, preparedRecord,
        );
      }

      let changedRecord = { ...preparedRecord };
      if (tableDefinition.strict) {
        changedRecord = {};
      }

      Object.keys(tableDefinition.relationships).forEach((attribute) => {
        if (attribute in preparedRecord) {
          const relationshipDef = tableDefinition.relationships[attribute];
          // belongs to
          if (relationshipDef.type === 'belongsTo') {
            const relatedTable = indexes.belongsTo[table][relationshipDef.column].foreignTable;
            const relTableId = internalGenerateChangeset(relatedTable, preparedRecord[attribute]);
            changedRecord[relationshipDef.column] = relTableId;
            delete changedRecord[attribute];
            delete preparedRecord[attribute];
          }

          // has many
          if (relationshipDef.type === 'hasMany') {
            const relatedTable = indexes.hasMany[table][relationshipDef.column].primaryTable;
            let relatedRecords = preparedRecord[attribute] || [];
            if (!(relatedRecords instanceof Array)) {
              relatedRecords = Object.keys(relatedRecords).map(
                rrid => ({ id: parseInt(rrid, 10), ...relatedRecords[rrid] }),
              );
            }

            relatedRecords.forEach((internalRecord) => {
              internalGenerateChangeset(relatedTable, {
                ...internalRecord,
                [relationshipDef.belongsToColumn]: recordId,
              });
            });
            delete changedRecord[attribute];
            delete preparedRecord[attribute];
          }
        }
      });

      const validationsToCheck = {};

      Object.keys(tableDefinition.attributes).forEach((attribute) => {
        const attributeDefinition = tableDefinition.attributes[attribute];

        if (isNew && preparedRecord[attribute] === undefined) {
          preparedRecord[attribute] = attributeDefinition.defaultValue;
        }

        if (attribute in preparedRecord) {
          if (attributeDefinition.type === 'type') {
            if (changedRecord[attribute] === undefined) {
              changedRecord[attribute] = preparedRecord[attribute];
            }

            changedRecord[attribute] = attributeDefinition.cast(changedRecord[attribute]);

            if (attributeDefinition.required) validationsToCheck[attribute] = true;
          }
        }
      });

      Object.keys(validationsToCheck).forEach((attribute) => {
        const attributeDefinition = tableDefinition.attributes[attribute];
        validateRequired(changedRecord, attribute, table, attributeDefinition);
      });

      changedRecord.id = recordId;
      changedRecord = tableDefinition.hooks.afterChange.reduce(
        (result, hook) => hook(result, data) || result, changedRecord,
      );
      if (isNew) {
        changedRecord = tableDefinition.hooks.afterCreate.reduce(
          (result, hook) => hook(result, data) || result, changedRecord,
        );
      } else {
        changedRecord = tableDefinition.hooks.afterUpdate.reduce(
          (result, hook) => hook(result, data) || result, changedRecord,
        );
      }

      changeset[table][recordId] = {
        ...changedRecord,
        id: recordId,
      };


      return recordId;
    };

    internalGenerateChangeset(initialTable, initialRecord);

    return changeset;
  }

  // Remove has many references from the record
  static stripReferences(table, record) {
    if (!record) return record;
    const recordWithoutIndexes = { ...record };

    const dataTypeReferences = indexes.hasMany[table] || {};
    Object.keys(dataTypeReferences).forEach((attribute) => {
      delete recordWithoutIndexes[attribute];
    });
    return recordWithoutIndexes;
  }

  /**
  Searches a given tableAndAttribute index name for the value
  */
  static searchIndex(tableAndAttribute, value) {
    let type = 'generic';
    try {
      const [table, attribute] = tableAndAttribute.split('.');
      const attributeDefinition = indexes.tables[table].attribute || { cast: d => d };
      const searchValue = attributeDefinition.cast(value);
      const { data } = indexes.indexes[table][attribute];
      ({ type } = indexes.indexes[table][attribute]);
      if (type === 'unique') return data[searchValue];
      return Object.values(data[searchValue]);
    } catch {
      if (type === 'unique') return null;
      return [];
    }
  }

  /**
  Returns the index keys for a given tableAndAttribute index name
  */
  static getIndexedValues(tableAndAttribute) {
    try {
      const [table, attribute] = tableAndAttribute.split('.');
      return Object.keys(indexes.indexes[table][attribute].data);
    } catch {
      return [];
    }
  }

  /**
  returns all the records that should be deleted if deleting the given record.
  */
  static delete(externalTable, recordOrId, data = {}) {
    const externalRecordId = recordOrId.id ? recordOrId.id : recordOrId;
    const deletes = { [externalTable]: { [externalRecordId]: 'DELETE' } };
    const internalCascade = (table, recordId) => {
      Object.keys(indexes.hasMany[table]).forEach((attribute) => {
        const { data: indexData, primaryTable, cascadeAction } = indexes.hasMany[table][attribute];

        const primaryData = data[primaryTable] || {};

        deletes[primaryTable] = {
          ...deletes[primaryTable] || {},
          ...Object.keys(indexData[recordId] || {}).reduce((agg, rid) => (
            {
              ...agg,
              [rid]: cascadeAction({ ...primaryData[rid] || {}, id: parseInt(rid, 10) }),
            }),
          {}),
        };

        Object.values(indexData[recordId] || {}).forEach(
          childRecordId => internalCascade(primaryTable, childRecordId),
        );
      });
    };

    internalCascade(externalTable, externalRecordId);

    return deletes;
  }

  /**
  Auto increments and returns the next primary key for the give table
  */
  static nextPrimaryKey(dataTable) {
    indexes.tables[dataTable].primaryKey += 1;
    return indexes.tables[dataTable].primaryKey;
  }

  /**
  Builds the indexed database. If no changeset is given, it will rebuild the entire database.
  For faster rebuilding, provide a changeset.

  A changeset is an object containing table and records that have been changed. Indexes will be
  rebuild if changes to the index value are detected.

  Example:

  addUniqueIndex('users.email');

  rebuildIndexes({ users: { 1: { id: 1, email: 'johndoe@gmail.com' }}});
  => rebuilds all indexes

  changeset = { users: { 1: { id: 1, emaill: 'janedoe@gmail.com'}}}
  rebuildIndexes({ users: { 1: { id: 1, email: 'johndoe@gmail.com' }}}, changeset);
  => rebuilds the users.email index for only the johndoe@gmail.com email
  */
  static rebuildIndexes(data, changeset = null) {
    Object.keys(indexes.tables).forEach((dataTable) => {
      if (changeset && !changeset[dataTable]) return;

      const tableIndexes = Object.keys(indexes.indexes[dataTable] || {});
      const tableReferences = Object.keys(indexes.belongsTo[dataTable] || {});
      const primaryKeyIndex = indexes.tables[dataTable].primaryKey;
      if (tableIndexes.length || tableReferences.length || !primaryKeyIndex) {
        const generateIndexesForRecord = (record, previousRecordVersion = null) => {
          // create primary key indexes
          if (!primaryKeyIndex) {
            if (record.id && record.id > (indexes.tables[dataTable].primaryKey || 0)) {
              indexes.tables[dataTable].primaryKey = record.id;
            }
          }

          // create finding indexes
          tableIndexes.forEach((attribute) => {
            const { primaryKey, type } = indexes.indexes[dataTable][attribute];
            let attributeDefinition = indexes.tables[dataTable].attributes[attribute];
            attributeDefinition = attributeDefinition || { cast: d => d };

            if (!record[primaryKey] && !previousRecordVersion) return;

            const newValue = record === 'DELETE' ? 'DELETE' : attributeDefinition.cast(record[attribute]);
            const previousValue = previousRecordVersion
              ? attributeDefinition.cast(previousRecordVersion[attribute])
              : null;

            if (type === 'unique') {
              if (record === 'DELETE' || (previousRecordVersion && newValue !== previousValue)) {
                delete indexes.indexes[dataTable][attribute].data[previousValue];
              }

              if (record !== 'DELETE') {
                indexes.indexes[dataTable][attribute].data[newValue] = record[primaryKey];
              }
            } else {
              const indexData = indexes.indexes[dataTable][attribute].data;
              if (!indexData[newValue]) {
                indexData[newValue] = {};
              }
              if (record === 'DELETE' || (previousRecordVersion && newValue !== previousValue)) {
                delete indexData[previousValue][record[primaryKey]];
                if (Object.keys(indexData[previousValue]).length < 1) {
                  delete indexData[previousValue];
                }
              }
              if (record !== 'DELETE') {
                indexData[newValue][record[primaryKey]] = record[primaryKey];
              }
            }
          });

          // create reference indexes
          tableReferences.forEach((attribute) => {
            const { foreignTable, foreignKey, scope } = indexes.belongsTo[dataTable][attribute];

            const reference = indexes.hasMany[foreignTable][foreignKey];
            const { primaryKey } = reference;

            let attributeDefinition = indexes.tables[dataTable].attributes[attribute];
            attributeDefinition = attributeDefinition || { cast: d => d };

            const newValue = record === 'DELETE' ? 'DELETE' : attributeDefinition.cast(record[attribute]);
            const previousValue = previousRecordVersion
              ? attributeDefinition.cast(previousRecordVersion[attribute])
              : null;

            if (record === 'DELETE' && reference.data[previousValue]) {
              delete reference.data[previousValue][previousRecordVersion[primaryKey]];
              return;
            }

            if (previousRecordVersion && scope(previousRecordVersion)) {
              if (reference.data[previousValue]) {
                delete reference.data[previousValue][previousRecordVersion[primaryKey]];
              }
            }

            if (scope(record)) {
              if (record[primaryKey]) {
                if (!reference.data[newValue]) reference.data[newValue] = {};
                reference.data[newValue][record[primaryKey]] = record[primaryKey];
              }
            }
          });
        };

        const getData = indexes.tables[dataTable].getter || (d => d);

        if (changeset) {
          // If the table does not exist in provided data
          if (!data[dataTable]) return;
          Object.keys(changeset[dataTable]).forEach((recordId) => {
            generateIndexesForRecord(
              changeset[dataTable][recordId],
              getData(data[dataTable])[recordId],
            );
          });
        } else {
          // clear indexes first
          tableIndexes.forEach((attribute) => {
            indexes.indexes[dataTable][attribute].data = {};
          });

          tableReferences.forEach((attribute) => {
            const { foreignTable, foreignKey } = indexes.belongsTo[dataTable][attribute];
            indexes.hasMany[foreignTable][foreignKey].data = {};
          });

          // If the table does not exist in provided data
          if (!data[dataTable]) return;
          Object.values(getData(data[dataTable])).forEach((record) => {
            generateIndexesForRecord(record);
          });
        }
      }
    });
  }

  // === MODEL DEFINITIONS ===

  // Create a BelongsTo/HasMany relationship
  static addReference(belongsTo, hasMany, options = {}) {
    const [belongsToTable, belongsToColumnAndAttribute] = belongsTo.split('.');
    const [hasManyTable, hasManyColumnAndAttribute] = hasMany.split('.');

    // eslint-disable-next-line
    let [belongsToColumn, belongsToAttribute] = belongsToColumnAndAttribute.split(' as ');
    belongsToAttribute = belongsToAttribute || belongsToColumn.replace(/_id$/, '');

    // eslint-disable-next-line
    let [hasManyColumn, hasManyAttribute] = hasManyColumnAndAttribute.split(' as ');
    hasManyAttribute = hasManyAttribute || hasManyColumn.replace(/_ids$/, 's');

    if (!indexes.belongsTo[belongsToTable]) indexes.belongsTo[belongsToTable] = {};
    indexes.tables[belongsToTable].relationships[belongsToAttribute] = {
      type: 'belongsTo',
      column: belongsToColumn,
      required: options.required === undefined ? true : options.required,
    };

    indexes.belongsTo[belongsToTable][belongsToColumn] = {
      foreignTable: hasManyTable,
      foreignKey: hasManyColumn,
      scope: options.scope || (() => true),
    };

    if (!indexes.hasMany[hasManyTable]) indexes.hasMany[hasManyTable] = {};
    if (!indexes.tables[hasManyTable]) throw Error(`ObjectDB: Failed to add reference "${belongsTo}" => "${hasMany}".\nTable "${hasManyTable}" does not exist!`);
    indexes.tables[hasManyTable].relationships[hasManyAttribute] = {
      type: 'hasMany',
      column: hasManyColumn,
      belongsToColumn,
    };

    const dependentDestroy = () => 'DELETE';
    const dependentNullify = d => ({ ...d, [belongsToColumn]: null });
    let cascadeAction = options.dependent;
    if (cascadeAction === 'nullify') {
      cascadeAction = dependentNullify;
    }

    if (!cascadeAction) {
      cascadeAction = dependentDestroy;
    }

    indexes.hasMany[hasManyTable][hasManyColumn] = {
      primaryKey: options.primaryKey || 'id',
      primaryTable: belongsToTable,
      data: {},
      cascadeAction,
    };

    ObjectDB.addAttribute(`${belongsToTable}.${belongsToColumn}`, { type: 'number', required: options.required, relationship: belongsToAttribute });
  }

  /**
    Create an index for an attribute.
    This allows you to store additional methods of fast retrieval for a record.

    For example:
    addUniqueIndex('users.email');
    searchIndex('users.email', 'johndoe@gmail.com');
    => 1

    or generic indexes
    addIndex('users.email');
    findByIndex('users.email', 'johndoe@gmail.com');
    => [1, 2]
  */
  static addIndex(tableAndAttribute, options = {}) {
    const [table, attribute] = tableAndAttribute.split('.');
    if (!indexes.indexes[table]) indexes.indexes[table] = {};

    if (options.type === 'unique') {
      indexes.tables[table].unique[attribute] = {
        name: tableAndAttribute,
      };
    }

    indexes.indexes[table][attribute] = {
      primaryKey: options.primaryKey || 'id',
      type: options.type || 'generic',
      data: {},
    };
  }

  /**
  Alias for addIndex(tableAndAttribute, { type: 'unique' })
  */
  static addUniqueIndex(tableAndAttribute, options = {}) {
    ObjectDB.addIndex(tableAndAttribute, { ...options, type: 'unique' });
  }

  /**
  Adds a new table + primary key tracker to the data model
  */
  static addTable(table, options = {}) {
    indexes.tables[table] = {
      getter: options.getter || (d => d),
      attributes: {},
      relationships: {},
      unique: {},
      primaryKey: 0,
      strict: !!options.strict,
      hooks: {
        beforeChange: [],
        beforeCreate: [],
        beforeUpdate: [],
        afterChange: [],
        afterCreate: [],
        afterUpdate: [],
      },
    };

    const mergeWithPreviousValueBeforeChange = (record, data) => {
      const tableData = indexes.tables[table].getter(data)[table] || {};
      if (tableData && tableData[record.id]) {
        return {
          ...tableData[record.id],
          ...record,
        };
      }
      return record;
    };
    ObjectDB.addHook(`${table}.beforeChange`, mergeWithPreviousValueBeforeChange);
  }

  static addHook(tableAndHook, action) {
    const [table, hook] = tableAndHook.split('.');
    indexes.tables[table].hooks[hook].push(action);
  }

  static addAttribute(tableAndAttribute, options = {}) {
    const [table, attribute] = tableAndAttribute.split('.');

    const isNull = (v) => {
      if (v === undefined) return true;
      if (v === null) return true;
      if (Number.isNaN(v)) return true;
      return false;
    };

    let { cast } = options;
    if (!cast) {
      switch (options.type) {
        case 'number':
        case 'float':
          cast = d => parseFloat(d);
          break;
        case 'integer':
          cast = d => parseInt(d, 10);
          break;
        case 'string':
          cast = d => `${d}`;
          break;
        case 'boolean':
          cast = d => !!d;
          break;
        default:
          cast = d => d;
      }
    }

    indexes.tables[table].attributes[attribute] = {
      type: 'type',
      defaultValue: options.defaultValue === undefined ? null : options.defaultValue,
      cast: d => (isNull(d) ? null : cast(d)),
      required: options.required || false,
      relationship: options.relationship,
    };
  }


  /**
  Debug: Logs the index database
  */
  static logIndexes() {
    // eslint-disable-next-line
    console.log(indexes);
    return indexes;
  }
}
