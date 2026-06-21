import { ProjectDetailView } from "@/components/tempus/kiosk/ProjectDetailView";

export default async function KioskTempusProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectDetailView id={id} />;
}
