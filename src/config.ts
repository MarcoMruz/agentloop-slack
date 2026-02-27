import { z } from "zod";
import { homedir } from "node:os";
import "dotenv/config";

const ConfigSchema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  ALLOWED_USER_IDS: z
    .string()
    .default("")
    .transform((s) => (s ? s.split(",").map((id) => id.trim()) : [])),
  AGENTLOOP_SOCKET: z
    .string()
    .default("~/.local/share/agentloop/agentloop.sock")
    .transform((p) => p.replace(/^~/, homedir())),

  // Quick integrations (optional, bypass agent)
  OPENWEATHER_API_KEY: z.string().optional(),
  GOOGLE_CALENDAR_CREDENTIALS: z.string().optional(),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(20),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config = ConfigSchema.parse(process.env);
