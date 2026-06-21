import { loadSecrets } from "@/lib/azure/keyvault";

export async function register() {
  await loadSecrets();
}
