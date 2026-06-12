import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(8080),
    DATABASE_URL: z.string().url(),
    STELLAR_RPC_URL: z.string().url(),
    STELLAR_HORIZON_URL: z.string().url(),
    STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
    RELAYER_SECRET: z.string().length(56),
    FACTORY_ID: z.string().length(56),
    INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
    INDEXER_MAX_WINDOW: z.coerce.number().int().positive().default(100000),
    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    EXECUTOR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
    REVEAL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    CHANNEL_COUNT: z.coerce.number().int().positive().default(8),
    CHANNEL_FUND_STROOPS: z.coerce.number().int().positive().default(30000000),
    CHANNEL_MIN_BALANCE_STROOPS: z.coerce.number().int().positive().default(20000000),
    REVEAL_FLOW_FEE_STROOPS: z.coerce.number().int().positive().default(120000),
    FEE_MARGIN_BPS: z.coerce.number().int().nonnegative().default(2000),
    FEE_TIER_STROOPS: z.coerce.number().int().positive().default(100000),
    FEE_FALLBACK_INCLUSION_STROOPS: z.coerce.number().int().nonnegative().default(200),
    FEE_QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  })
  .refine((c) => c.CHANNEL_MIN_BALANCE_STROOPS < c.CHANNEL_FUND_STROOPS, {
    message:
      "CHANNEL_MIN_BALANCE_STROOPS must be below CHANNEL_FUND_STROOPS so top-ups raise the balance",
  });

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
