import { server } from "../server/index.js";
import { PAGES_OPERATION_SCHEMA } from "../schema/page.js";
import { BLOCKS_OPERATION_SCHEMA } from "../schema/blocks.js";
import { DATABASE_OPERATION_SCHEMA } from "../schema/database.js";
import { COMMENTS_OPERATION_SCHEMA } from "../schema/comments.js";
import { USERS_OPERATION_SCHEMA } from "../schema/users.js";
import { registerPagesOperationTool } from "./pages.js";
import { registerBlocksOperationTool } from "./blocks.js";
import { registerDatabaseOperationTool } from "./database.js";
import { registerCommentsOperationTool } from "./comments.js";
import { registerUsersOperationTool } from "./users.js";

export const registerAllTools = () => {
  // Register combined pages operation tool
  server.tool(
    "notion_pages",
    "Perform various page operations (create, archive, restore, search, update)",
    PAGES_OPERATION_SCHEMA,
    registerPagesOperationTool
  );

  // Register combined blocks operation tool
  server.tool(
    "notion_blocks",
    "Perform various block operations (retrieve, update, delete, append children, batch operations)",
    BLOCKS_OPERATION_SCHEMA,
    registerBlocksOperationTool
  );

  // Register combined database operation tool
  server.tool(
    "notion_database",
    "Perform various database operations (create, query, compact table reads, aggregate, summarize, update)",
    DATABASE_OPERATION_SCHEMA,
    registerDatabaseOperationTool
  );

  // Register combined comments operation tool
  server.tool(
    "notion_comments",
    "Perform various comment operations (get, add to page, add to discussion)",
    COMMENTS_OPERATION_SCHEMA,
    registerCommentsOperationTool
  );

  // Register combined users operation tool
  server.tool(
    "notion_users",
    "Perform various user operations (list, get, get bot)",
    USERS_OPERATION_SCHEMA,
    registerUsersOperationTool
  );
};
