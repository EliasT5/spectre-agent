import { EntriesView } from "@/components/tempus/kiosk/EntriesView";

export default async function KioskTempusEntriesPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { projectId } = await searchParams;
  return <EntriesView initialProjectId={projectId ?? ""} />;
}
