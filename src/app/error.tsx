"use client";
import { ErrorTile } from "@/components/ErrorTile";

// Catches the blob home + any segment without its own boundary.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorTile error={error} reset={reset} scope="Spectre" />;
}
