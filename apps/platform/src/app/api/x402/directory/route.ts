import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "public", ".well-known", "agent-services.json");
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Directory metadata not found" }, { status: 404 });
    }
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return NextResponse.json(content, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: "Failed to load directory" }, { status: 500 });
  }
}
