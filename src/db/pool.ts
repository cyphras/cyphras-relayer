import { Pool } from "pg";
import { config } from "../config/index.js";

export const db = new Pool({ connectionString: config.DATABASE_URL });
