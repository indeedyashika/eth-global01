import { NextRequest, NextResponse } from "next/server";
import { getWorkflowState, resetWorkflowState } from "@/lib/workflow/judgeWorkflow";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = getWorkflowState();
    return NextResponse.json({ success: true, state });
  } catch (err: any) {
    console.error("[workflow/status] Error fetching workflow state:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Failed to load workflow state." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "RESET") {
      const state = resetWorkflowState();
      return NextResponse.json({ success: true, state });
    }
    const state = getWorkflowState();
    return NextResponse.json({ success: true, state });
  } catch (err: any) {
    console.error("[workflow/status] Error modifying workflow state:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Failed to update workflow state." },
      { status: 500 }
    );
  }
}
