"use client";
import { ErrorTile } from "@/components/ErrorTile";

export default function LibraryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorTile error={error} reset={reset} scope="Library" />;
}
