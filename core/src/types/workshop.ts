export interface WorkshopTask {
  id: string;
  title: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  claude_output: string;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}
