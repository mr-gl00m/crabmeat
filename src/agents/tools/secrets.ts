/**
 * Secret store interface for resolving $SECRET:name references.
 * Secrets are resolved at the execution boundary — never in the context window.
 */
export interface SecretStore {
  resolve(name: string): string | undefined;
}

const SECRET_REF_PATTERN = /^\$SECRET:(.+)$/;

/**
 * Check if a value is a secret reference.
 */
export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && SECRET_REF_PATTERN.test(value);
}

/**
 * Extract the secret name from a $SECRET:name reference.
 */
export function parseSecretRef(value: string): string | undefined {
  const match = SECRET_REF_PATTERN.exec(value);
  return match?.[1];
}

/**
 * Default secret store backed by environment variables.
 * $SECRET:GITHUB_TOKEN → process.env.GITHUB_TOKEN
 */
export function createEnvSecretStore(): SecretStore {
  return {
    resolve(name: string): string | undefined {
      return process.env[name];
    },
  };
}
