# ObjectDB

Flux/React framework for creating any document, just define a few DOM components to transform into the document.

See an example of how to generate Spreadsheets https://github.com/humphreyja/sample-doc-flux-spreadsheets

# Examples

### Create the data model and populate the database
```js

// Create data model
ObjectDB.addTable('users');
ObjectDB.addTable('tasks');

ObjectDB.addUniqueIndex('users.email');
ObjectDB.addIndex('tasks.completed');
ObjectDB.addReference('tasks.user_id', 'users.task_ids', { scope: d => !d.parent_task_id });
ObjectDB.addReference('tasks.parent_task_id', 'tasks.task_ids', { scope: d => !!d.parent_task_id });



const data = {
  users: {
    1: { id: 1, email: 'johndoe@gmail.com' }
  },
  tasks: {
    1: { id: 1, name: 'Clean House', completed: false, user_id: 1, parent_task_id: null },
    2: { id: 2, name: 'Wash Dishes', completed: false, user_id: 1, parent_task_id: 1 },
    3: { id: 3, name: 'Do Laundry',completed: true, user_id: 1, parent_task_id: 1 },
  }
}

// Build the database
ObjectDB.rebuildIndexes(data);
```

**Important: Data is not stored in database**. The database only contains indexes


### Assign References to a record
```js
const user = ObjectDB.assignReferences('users', data.users[1]);
console.log(user);
// => { id: 1, email: 'johndoe@gmail.com', task_ids: [1] }

const task = ObjectDB.assignReferences('tasks', data.tasks[1]);
console.log(task);
// => { id: 1, name: 'Clean House', task_ids: [2, 3], ... }
```

### Search indexes
```js
console.log(ObjectDB.searchIndex('users.email', 'johndoe@gmaill.com'));
// => 1

console.log(ObjectDB.searchIndex('tasks.completed', false));
// => [1, 2]
```

### Cascade changes
Find the records that should be deleted if you delete the provided record.
```js
// cascade creates a changeset containing the records that need to be deleted
const changeset = ObjectDB.cascade('users', data.users[1]);
console.log(changeset);
// => { users: { 1: {}}, tasks: { 1: {}, 2: {}, 3: {}}}

// Rebuild the indexes by providing the original(or cloned) dataset and the changeset as the second argument
ObjectDB.rebuildIndexes(data, changeset);

// Finally, delete the records
Object.keys(changeset).forEach((table) => {
  Object.keys(changeset[tabe]).forEach((id) => {
    delete data[table][id];
  });
});
```

## Development
[Clone](https://help.github.com/articles/cloning-a-repository/) this repo, and begin committing changes. PRs are preferred over committing directly to master.

To run tests locally on your machine, run the following:
```bash
yarn run test
```

To preview documentation locally on your machine, run the following:
```bash
yarn run build-docs
```

After merging your pull request, consider updating the documentation with the following command:
```bash
yarn run publish-docs
```

To deploy a new version to NPM, bump the version number, commit/merge to `master`, and run the following:
```bash
yarn run clean
yarn run build

# Either NPM
npm publish
# Or Yarn, they do the same thing
yarn publish
```

## License
This project is [MIT licensed](https://github.com/HarvestProfit/DocFlux/blob/master/LICENSE)
