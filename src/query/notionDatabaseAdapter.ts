import { notion } from "../services/notion.js";

export interface DatabaseAdapter {
  retrieveDatabase(databaseId: string): Promise<any>;
  queryDatabase(params: Record<string, unknown>): Promise<any>;
  retrievePage(pageId: string): Promise<any>;
}

export const notionDatabaseAdapter: DatabaseAdapter = {
  retrieveDatabase(databaseId: string): Promise<any> {
    return notion.databases.retrieve({ database_id: databaseId });
  },

  queryDatabase(params: Record<string, unknown>): Promise<any> {
    return notion.databases.query(params as any);
  },

  retrievePage(pageId: string): Promise<any> {
    return notion.pages.retrieve({ page_id: pageId });
  },
};
