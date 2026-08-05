import { parse as parseYaml } from "yaml";
import { z } from "zod";

const permission = z.enum(["read", "write"]);

const apiKeyPrincipal = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex digest"),
    namespaces: z.array(z.string()),
    permissions: z.array(permission),
  })
  .strict();

// "enabled" is a reserved key; every other key is a principal name.
const apiKeys = z.object({ enabled: z.boolean() }).catchall(apiKeyPrincipal);

const anonymous = z
  .object({
    enabled: z.boolean(),
    namespaces: z.array(z.string()).optional(),
    permissions: z.array(permission).optional(),
  })
  .strict();

const authentication = z
  .object({
    anonymous: anonymous.optional(),
    api_keys: apiKeys.optional(),
  })
  .strict();

const catalog = z
  .object({
    endpoint: z.string().min(1),
    backend_warehouse: z.string().min(1),
    backend_prefix: z
      .string()
      .refine((s) => !s.includes("/"), 'must be a single path segment (no "/")')
      .optional(),
    auth: z.object({ bearer_token: z.string().min(1) }).strict(),
    capabilities: z.object({ read: z.boolean(), write: z.boolean() }).strict(),
  })
  .strict();

const server = z.object({ host: z.string(), port: z.number().int().positive() }).strict();
const cors = z.object({ enabled: z.boolean(), origins: z.array(z.string()) }).strict();

const configSchema = z
  .object({
    server: server.optional(),
    cors: cors.optional(),
    authentication,
    catalogs: z.record(z.string(), catalog),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const names = Object.keys(cfg.catalogs);
    if (names.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at least one catalog is required", path: ["catalogs"] });
    }
    for (const name of names) {
      if (name.includes("/")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `catalog name "${name}" must be a single path segment (no "/")`,
          path: ["catalogs", name],
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Recursively replaces ${VAR} in every string value. Throws with the
// variable name and config path when a referenced variable is unset.
function interpolate(value: unknown, env: Record<string, string | undefined>, path: string[]): unknown {
  if (typeof value === "string") {
    return value.replace(VAR_PATTERN, (_match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        throw new Error(`Config error at "${path.join(".") || "(root)"}": environment variable "${name}" is not set`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolate(item, env, [...path, String(i)]));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolate(v, env, [...path, k])]),
    );
  }
  return value;
}

/**
 * Parses and validates an icegate YAML config. `${VAR}` references are
 * resolved against `env` (caller supplies process.env or a Workers env
 * binding — this module never reads process.env itself).
 *
 * Throws on invalid YAML, an unset referenced variable, or a schema/
 * cross-field validation failure. Never returns partial/invalid config.
 */
export function loadConfig(yamlText: string, env: Record<string, string | undefined>): Config {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`Config error: invalid YAML: ${(err as Error).message}`);
  }

  const interpolated = interpolate(raw, env, []);

  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Config validation failed: ${issues}`);
  }

  return result.data;
}
