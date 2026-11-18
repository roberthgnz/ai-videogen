const Database = require("./runtime/node_modules/better-sqlite3");
const source = new Database(process.argv[2], { readonly: true, fileMustExist: true });
source.backup(process.argv[3]).then(() => source.close()).catch(() => { source.close(); process.exitCode = 1; });
