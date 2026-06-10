"use client";

/**
 * /m/[moduleId] — the generic Data-mode host route.
 *
 * A module whose manifest is `uiMode: "data"` ships its UI as a UI Schema v2
 * doc in `ui.schema`. This route fetches the RAW v2 manifest, then hands the
 * schema to <SchemaRuntime>, which renders it on the shared kit — so a data
 * module looks like a built-in with ZERO module React. `native` modules just
 * have their real route opened; `code` modules are a P2d placeholder. The blob
 * navigation is unchanged — slots still open `m.route` ('/m/<id>' for data
 * modules).
 */

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getModuleV2 } from "@/lib/module-registry";
import type { ModuleManifestV2, ModulePermissions } from "@/lib/module-manifest";
import {
  EmptyState,
  ErrorState,
  Skeleton,
  TabShell,
  SchemaRuntime,
  ModuleFrame,
  type UISchemaV2,
} from "@/components/ui";

/** Narrow the opaque `ui` field to a v2 schema if it carries one. */
function readSchema(ui: unknown): UISchemaV2 | null {
  if (!ui || typeof ui !== "object") return null;
  const schema = (ui as { schema?: unknown }).schema;
  if (!schema || typeof schema !== "object") return null;
  if ((schema as { version?: unknown }).version !== 2) return null;
  return schema as UISchemaV2;
}

/** Does the opaque `ui` field carry a Code-mode bundle (ui.code.entry)? */
function hasCode(ui: unknown): boolean {
  if (!ui || typeof ui !== "object") return false;
  const code = (ui as { code?: unknown }).code;
  if (!code || typeof code !== "object") return false;
  return typeof (code as { entry?: unknown }).entry === "string";
}

type Load =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "ready"; module: ModuleManifestV2 };

export default function ModuleDataPage({
  params,
}: {
  params: Promise<{ moduleId: string }>;
}) {
  // params is a Promise in Next 16 — unwrap with React.use.
  const { moduleId } = use(params);
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ phase: "loading" });

  useEffect(() => {
    let active = true;
    getModuleV2(moduleId).then((m) => {
      if (!active) return;
      setLoad(m ? { phase: "ready", module: m } : { phase: "missing" });
    });
    return () => {
      active = false;
    };
  }, [moduleId]);

  if (load.phase === "loading") {
    return (
      <TabShell title="Loading" eyebrow="MODULE" tone="off" status="resolving…">
        <Skeleton height={120} />
        <Skeleton height={180} />
      </TabShell>
    );
  }

  if (load.phase === "missing") {
    return (
      <TabShell title="Not found" eyebrow="MODULE" tone="crit" status="unknown id">
        <EmptyState>No module “{moduleId}” in the registry.</EmptyState>
      </TabShell>
    );
  }

  const m = load.module;

  // native modules live at their own route — bounce there.
  if (m.uiMode === "native") {
    router.replace(m.route);
    return (
      <TabShell title={m.label} eyebrow="MODULE" tone="off" status="opening…">
        <Skeleton height={120} />
      </TabShell>
    );
  }

  // code mode — run the untrusted bundle inside the sandboxed ModuleFrame.
  if (m.uiMode === "code") {
    if (!hasCode(m.ui)) {
      return (
        <TabShell title={m.label} eyebrow="MODULE" tone="crit" status="bad manifest">
          <ErrorState>This module declares uiMode “code” but carries no ui.code bundle.</ErrorState>
        </TabShell>
      );
    }
    return <ModuleFrame moduleId={m.id} manifest={m} permissions={m.permissions ?? {}} />;
  }

  // data mode — render the schema on the host kit.
  const schema = readSchema(m.ui);
  if (!schema) {
    return (
      <TabShell title={m.label} eyebrow="MODULE" tone="crit" status="bad manifest">
        <ErrorState>This module declares uiMode “data” but carries no UI Schema v2.</ErrorState>
      </TabShell>
    );
  }

  const permissions: ModulePermissions = m.permissions ?? {};
  return <SchemaRuntime moduleId={m.id} schema={schema} permissions={permissions} />;
}
