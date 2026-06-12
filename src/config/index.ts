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
    // Optional additional master secrets (comma-separated), each funding its own channels. Clients
    // pick which master receives the fee by binding its public key into the proof; the relayer
    // routes each reveal to the matching master. Empty means a single master (RELAYER_SECRET).
    RELAYER_EXTRA_SECRETS: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x.length > 0),
      )
      .refine((arr) => arr.every((x) => x.length === 56), {
        message: "each RELAYER_EXTRA_SECRETS entry must be a 56-char Stellar secret",
      }),
    FACTORY_ID: z.string().length(56),
    INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
    INDEXER_MAX_WINDOW: z.coerce.number().int().positive().default(100000),
    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    EXECUTOR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
    REVEAL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    CHANNEL_COUNT: z.coerce.number().int().positive().default(8),
    CHANNEL_FUND_STROOPS: z.coerce.number().int().positive().default(30000000),
    CHANNEL_MIN_BALANCE_STROOPS: z.coerce.number().int().positive().default(20000000),
    MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
    KEEPER_EXTEND_LEDGERS: z.coerce.number().int().positive().default(500000),
    KEEPER_THRESHOLD_LEDGERS: z.coerce.number().int().positive().default(100000),
    MASTER_MIN_BALANCE_STROOPS: z.coerce.number().int().positive().default(500000000),
    REVEAL_FLOW_FEE_STROOPS: z.coerce.number().int().positive().default(120000),
    FEE_MARGIN_BPS: z.coerce.number().int().nonnegative().default(2000),
    FEE_TIER_STROOPS: z.coerce.number().int().positive().default(100000),
    FEE_FALLBACK_INCLUSION_STROOPS: z.coerce.number().int().nonnegative().default(200),
    FEE_QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    FEE_SAMPLE_SIZE: z.coerce.number().int().positive().default(50),
    JOB_RETENTION_HOURS: z.coerce.number().int().positive().default(168),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(16384),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    // Set to the number of trusted proxy hops when deployed behind a reverse proxy, so the rate
    // limit keys on the real client IP instead of the proxy's. Left at 0, the proxy is not trusted
    // (correct for a direct bind); never set a bare "true" with an untrusted X-Forwarded-For.
    TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
    // Comma-separated web origins allowed to call the API from a browser (e.g. a wallet extension).
    // "*" allows any origin, which is fine for this credential-less public API.
    ALLOWED_ORIGINS: z.string().default("*"),
    // An unset env var arrives as "" here, not undefined, so treat empty as absent before the
    // url check; otherwise a blank ALERT_WEBHOOK_URL would fail validation and crash startup.
    ALERT_WEBHOOK_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  })
  .refine((c) => c.CHANNEL_MIN_BALANCE_STROOPS < c.CHANNEL_FUND_STROOPS, {
    message:
      "CHANNEL_MIN_BALANCE_STROOPS must be below CHANNEL_FUND_STROOPS so top-ups raise the balance",
  });

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
