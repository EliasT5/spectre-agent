"use client";
import { ErrorTile } from "@/components/ErrorTile";

export default function MonitorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorTile error={error} reset={reset} scope="Monitor" />;
}
