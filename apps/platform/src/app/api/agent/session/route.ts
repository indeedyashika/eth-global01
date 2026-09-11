import { NextRequest, NextResponse } from "next/server";
import {
  getActiveSession,
  createSessionGrant,
  SessionPolicyConstraints,
  SESSION_KEY_EIP712_DOMAIN,
  SESSION_KEY_EIP712_TYPES,
  VALIDATOR_CONTRACT_ADDRESS,
  HERMES_AGENT_ADDRESS,
  isGrantorNonceUsed,
  NonceReplayError,
  AuthenticationError,
} from "@/lib/hermes/sessionPolicy";

export async function GET(req: NextRequest) {
  const grantor = req.nextUrl.searchParams.get("grantor") || undefined;
  const session = getActiveSession(grantor);
  return NextResponse.json({
    success: true,
    session: session ?? null,
    eip712: {
      domain: SESSION_KEY_EIP712_DOMAIN,
      types: SESSION_KEY_EIP712_TYPES,
      validatorContract: VALIDATOR_CONTRACT_ADDRESS,
      agentAddress: HERMES_AGENT_ADDRESS,
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { grantor, signature, constraints, nonce, rawMessage, validAfter, agent } = body as {
      grantor: string;
      signature: string;
      constraints?: Partial<SessionPolicyConstraints>;
      nonce?: number;
      rawMessage?: string;
      validAfter?: number;
      agent?: string;
    };

    if (!grantor || !signature) {
      return NextResponse.json(
        { success: false, error: "Missing required grantor address or wallet signature." },
        { status: 400 }
      );
    }

    const assignedNonce = nonce ?? Date.now();

    if (isGrantorNonceUsed(grantor, assignedNonce)) {
      return NextResponse.json(
        {
          success: false,
          error: `Nonce ${assignedNonce} has already been registered for grantor ${grantor}. Replay rejected.`,
        },
        { status: 409 }
      );
    }

    const session = createSessionGrant(
      grantor,
      signature,
      constraints,
      assignedNonce,
      rawMessage,
      { validAfter, agent }
    );

    return NextResponse.json({
      success: true,
      message: "ERC-7579 Scoped Session Key registered and verified cryptographically.",
      session,
      validatorContract: VALIDATOR_CONTRACT_ADDRESS,
    });
  } catch (err: any) {
    if (err instanceof NonceReplayError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 409 });
    }
    if (err instanceof AuthenticationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 401 });
    }
    return NextResponse.json(
      { success: false, error: err.message || "Failed to create agent session" },
      { status: 400 }
    );
  }
}
