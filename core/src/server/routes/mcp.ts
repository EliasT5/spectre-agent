import { Hono } from "hono";
import { readFileSync } from "fs";
import { join } from "path";

type CatalogEntry = {
  name: string;
  category: string;
  description: string;
};

function brokerRoot(): string {
  return process.env.SPECTRE_REPO_PATH || process.cwd();
}

function loadCatalog(): CatalogEntry[] {
  try {
    const path = join(brokerRoot(), "spectre-mcp-broker", "tools-catalog.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is CatalogEntry =>
        entry &&
        typeof entry === "object" &&
        typeof entry.name === "string" &&
        typeof entry.category === "string" &&
        typeof entry.description === "string",
    );
  } catch {
    return [];
  }
}

export const mcp = new Hono();

mcp.get("/", (c) => {
  const brokerActive = process.env.SPECTRE_MCP_BROKER === "1";
  const catalog = loadCatalog();

  const tools = catalog.map((entry) => ({
    name: entry.name,
    category: entry.category,
    description: entry.description,
  }));

  const servers = [
    {
      name: "jerome",
      description:
        "The only MCP server Jerome runs. Gates write-side calls behind the chat approval modal; orchestration tools (gemini.execute, openai.*) sit here too.",
      transport: "stdio",
      command: `node ${process.env.SPECTRE_MCP_BROKER_PATH || join(process.cwd(), "spectre-mcp-broker", "index.mjs")}`,
      active: brokerActive,
      activatedBy: "SPECTRE_MCP_BROKER=1 in your environment",
      tools,
    },
  ];

  return c.json({ servers });
});
