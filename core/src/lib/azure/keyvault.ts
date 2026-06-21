import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

let cachedSecrets: Record<string, string> | null = null;

const VAULT_URL = process.env.AZURE_KEYVAULT_URL;

/**
 * Loads secrets from Azure Key Vault using Managed Identity.
 * Falls back to environment variables when Key Vault is not configured (local dev).
 */
export async function getSecret(name: string): Promise<string> {
  // Local dev: fall back to env vars
  if (!VAULT_URL) {
    const envValue = process.env[name];
    if (!envValue) throw new Error(`Missing env var: ${name}`);
    return envValue;
  }

  if (cachedSecrets?.[name]) return cachedSecrets[name];

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(VAULT_URL, credential);

  // Key Vault uses hyphens, env vars use underscores
  const vaultName = name.replace(/_/g, "-");
  const secret = await client.getSecret(vaultName);

  if (!secret.value) throw new Error(`Secret ${vaultName} has no value`);

  if (!cachedSecrets) cachedSecrets = {};
  cachedSecrets[name] = secret.value;

  return secret.value;
}

/**
 * Preloads all required secrets into process.env.
 * Call once at app startup or in middleware.
 */
export async function loadSecrets(): Promise<void> {
  if (!VAULT_URL) return; // local dev uses .env.local directly

  const secretNames = [
    "OPENAI_API_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PIN_HASH",
    "SESSION_SECRET",
  ];

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(VAULT_URL, credential);

  await Promise.all(
    secretNames.map(async (name) => {
      const vaultName = name.replace(/_/g, "-");
      try {
        const secret = await client.getSecret(vaultName);
        if (secret.value) {
          process.env[name] = secret.value;
        }
      } catch (err) {
        console.warn(`Failed to load secret ${vaultName}:`, err);
      }
    })
  );
}
