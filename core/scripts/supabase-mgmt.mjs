import fs from "node:fs";

const PAT = process.env.SUPA_PAT;
const API = "https://api.supabase.com";
const [cmd, ref, arg] = process.argv.slice(2);

if (!PAT) { console.error("SUPA_PAT env var required"); process.exit(2); }

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PAT}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  return { status: res.status, text };
}

if (cmd === "apply-sql") {
  const sql = fs.readFileSync(arg, "utf8");
  const { status, text } = await api(`/v1/projects/${ref}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query: sql }),
  });
  console.log("HTTP", status);
  console.log(text.slice(0, 3000));
  process.exit(status >= 200 && status < 300 ? 0 : 1);
} else if (cmd === "keys") {
  // anon + service_role live in the legacy api-keys endpoint; reveal=true
  // returns the secret service_role value.
  const { status, text } = await api(`/v1/projects/${ref}/api-keys?reveal=true`);
  console.log("HTTP", status);
  console.log(text);
  process.exit(status >= 200 && status < 300 ? 0 : 1);
} else {
  console.error("unknown command:", cmd);
  process.exit(2);
}
