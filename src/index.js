const indexes = {
  hasMany: {},
  belongsTo: {},
  indexes: {},
  primaryKeys: {},
  tables: {},
};

export default class ObjectDB {
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
      const { data } = indexes.indexes[table][attribute];
      ({ type } = indexes.indexes[table][attribute]);
      if (type === 'unique') return data[value];
      return Object.values(data[value]);
    } catch (e) {
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
      return Object.values(indexes.indexes[table][attribute].data);
    } catch (e) {
      return [];
    }
  }

  /**
  returns all the records that should be deleted if deleting the given record.
  */
  static cascade(externalTable, record) {
    const deletes = { [externalTable]: { [record.id]: {} } };
    const internalCascade = (table, recordId) => {
      Object.keys(indexes.hasMany[table]).forEach((attribute) => {
        const { data, primaryTable } = indexes.hasMany[table][attribute];

        deletes[primaryTable] = {
          ...deletes[primaryTable] || {},
          ...Object.keys(data[recordId] || {}).reduce((agg, r) => ({ ...agg, [r]: {} }), {}),
        };

        Object.values(data[recordId] || {}).forEach(
          childRecordId => internalCascade(primaryTable, childRecordId),
        );
      });
    };

    internalCascade(externalTable, record.id);

    return deletes;
  }

  /**
  Auto increments and returns the next primary key for the give table
  */
  static nextPrimaryKey(dataTable) {
    indexes.primaryKeys[dataTable] += 1;
    return indexes.primaryKeys[dataTable];
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
      const primaryKeyIndex = indexes.primaryKeys[dataTable];
      if (tableIndexes.length || tableReferences.length || primaryKeyIndex !== undefined) {
        const generateIndexesForRecord = (record, previousRecordVersion = null) => {
          // create primary key indexes
          if (primaryKeyIndex !== undefined) {
            if (record.id && record.id > (indexes.primaryKeys[dataTable] || 0)) {
              indexes.primaryKeys[dataTable] = record.id;
            }
          }

          // create finding indexes
          tableIndexes.forEach((attribute) => {
            const { primaryKey, type } = indexes.indexes[dataTable][attribute];
            if (!record[primaryKey]) return;
            if (type === 'unique') {
              if (previousRecordVersion && record[attribute] !== previousRecordVersion[attribute]) {
                delete indexes.indexes[dataTable][attribute].data[previousRecordVersion[attribute]];
              }

              indexes.indexes[dataTable][attribute].data[record[attribute]] = record[primaryKey];
            } else {
              const indexData = indexes.indexes[dataTable][attribute].data;
              if (!indexData[record[attribute]]) {
                indexData[record[attribute]] = {};
              }
              if (previousRecordVersion && record[attribute] !== previousRecordVersion[attribute]) {
                delete indexData[previousRecordVersion[attribute]][record[primaryKey]];
                if (Object.keys(indexData[previousRecordVersion[attribute]]).length < 1) {
                  delete indexData[previousRecordVersion[attribute]];
                }
              }
              indexData[record[attribute]][record[primaryKey]] = record[primaryKey];
            }
          });

          // create reference indexes
          tableReferences.forEach((attribute) => {
            const { foreignTable, foreignKey, scope } = indexes.belongsTo[dataTable][attribute];

            const reference = indexes.hasMany[foreignTable][foreignKey];
            if (scope(record)) {
              const { primaryKey } = reference;
              const referenceAttributeValue = record[attribute];
              const recordPrimaryValue = record[primaryKey];
              if (!reference.data[referenceAttributeValue]) {
                reference.data[referenceAttributeValue] = {};
              }

              if (previousRecordVersion && record[attribute] !== previousRecordVersion[attribute]) {
                delete reference.data[referenceAttributeValue][previousRecordVersion[primaryKey]];
              }

              if (recordPrimaryValue) {
                reference.data[referenceAttributeValue][recordPrimaryValue] = recordPrimaryValue;
              }
            }
          });
        };

        const getData = indexes.tables[dataTable] || (d => d);

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
    const [belongsToTable, belongsToColumn] = belongsTo.split('.');
    const [hasManyTable, hasManyColumn] = hasMany.split('.');

    if (!indexes.belongsTo[belongsToTable]) indexes.belongsTo[belongsToTable] = {};
    indexes.belongsTo[belongsToTable][belongsToColumn] = {
      foreignTable: hasManyTable,
      foreignKey: hasManyColumn,
      scope: options.scope || (() => true),
    };

    if (!indexes.hasMany[hasManyTable]) indexes.hasMany[hasManyTable] = {};
    indexes.hasMany[hasManyTable][hasManyColumn] = {
      primaryKey: options.primaryKey || 'id',
      primaryTable: belongsToTable,
      data: {},
    };
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
  static addTable(table, getter = d => d) {
    indexes.tables[table] = getter;
    indexes.primaryKeys[table] = 0;
  }


  /**
  Debug: Logs the index database
  */
  static logIndexes() {
    // eslint-disable-next-line
    console.log(indexes);
  }
}
