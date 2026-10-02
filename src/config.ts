import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const ConfigShape = z.object({
  DESIGNS_DIR: z.string().min(1),
  MACHINE_FILES_DIR: z.string().optional(),
  RUNS_DIR: z.string().default("runs"),
  DESIGNS_CATALOG: z.string().default("designs.json"),

  XDOPE_API_URL: z.string().url(),
  XDOPE_API_ENV: z.enum(["qa", "prod"]).default("qa"),
  XDOPE_AGENT_EMAIL: z.string().email(),
  XDOPE_AGENT_PASSWORD: z.string().min(1),

  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  IMAGE_PROVIDER: z.enum(["gemini", "flux"]).default("gemini"),
  IMAGE_MODEL: z.string().default("gemini-3.1-flash-image"),
  IMAGE_ESCALATION_MODEL: z.string().default("gemini-3.1-flash-image"),
  IMAGE_OUTPUT_SIZE: z
    .string()
    .regex(/^\d+x\d+$/)
    .default("1080x1350"),
  IMAGE_USE_BATCH: bool,
  GEMINI_API_KEY: z.string().optional(),
  BFL_API_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().min(1),

  MAX_IMAGE_COST_PER_PRODUCT: z.coerce.number().positive().default(3),
});

export const Config = ConfigShape.superRefine((c, ctx) => {
  if (c.IMAGE_PROVIDER === "gemini" && !c.GEMINI_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["GEMINI_API_KEY"], message: "Falta GEMINI_API_KEY para IMAGE_PROVIDER=gemini" });
  }
  if (c.IMAGE_PROVIDER === "flux" && !c.BFL_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["BFL_API_KEY"], message: "Falta BFL_API_KEY para IMAGE_PROVIDER=flux" });
  }
});
export type Config = z.infer<typeof Config>;

// El escaneo corre en el PC de Diego y no necesita claves de API.
export const ScanConfig = ConfigShape.pick({ DESIGNS_DIR: true, MACHINE_FILES_DIR: true, DESIGNS_CATALOG: true });
export type ScanConfig = z.infer<typeof ScanConfig>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  return parseOrThrow(Config, env);
}

export function loadScanConfig(env: Record<string, string | undefined>): ScanConfig {
  return parseOrThrow(ScanConfig, env);
}

function parseOrThrow<T>(schema: z.ZodType<T>, env: Record<string, string | undefined>): T {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Configuración inválida:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
