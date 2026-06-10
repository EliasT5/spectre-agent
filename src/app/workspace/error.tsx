"use client";
import { ErrorTile } from "@/components/ErrorTile";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorTile error={error} reset={reset} scope="Workspace" />;
}
