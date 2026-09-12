import { NextRequest, NextResponse } from "next/server";
import {
  getWorkflowState,
  recordStep1Oracle,
  recordStep2RentDeposit,
  recordStep3YieldClaim,
  recordStep4WorkspaceInspection,
  recordStep5WorldId,
  recordStep6CapTable,
  recordStep7Hermes,
  recordStep8Compromise,
  recordStep9Graph,
} from "@/lib/workflow/judgeWorkflow";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { step, data } = body;

    if (!step || typeof step !== "number") {
      return NextResponse.json(
        { success: false, error: "Step number (1-9) is required." },
        { status: 400 }
      );
    }

    let state;
    switch (step) {
      case 1:
        state = recordStep1Oracle(data);
        break;
      case 2:
        state = recordStep2RentDeposit(data);
        break;
      case 3:
        state = recordStep3YieldClaim(data);
        break;
      case 4:
        state = recordStep4WorkspaceInspection(data);
        break;
      case 5:
        state = recordStep5WorldId(data);
        break;
      case 6:
        state = recordStep6CapTable(data);
        break;
      case 7:
        state = recordStep7Hermes(data);
        break;
      case 8:
        state = recordStep8Compromise(data);
        break;
      case 9:
        state = recordStep9Graph(data);
        break;
      default:
        return NextResponse.json(
          { success: false, error: `Invalid step number: ${step}` },
          { status: 400 }
        );
    }

    return NextResponse.json({ success: true, state });
  } catch (err: any) {
    console.error("[workflow/step] Error processing step transition:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Failed to record step transition." },
      { status: 400 }
    );
  }
}
