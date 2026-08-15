import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { skillInputSchema } from "@/lib/validation";

export async function GET() {
  const skills = await prisma.skill.findMany({
    orderBy: [{ proficiency: "desc" }, { createdAt: "desc" }],
  });
  return NextResponse.json({ skills });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = skillInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { name, category, proficiency, notes } = parsed.data;
  const skill = await prisma.skill.create({
    data: {
      name,
      category,
      proficiency,
      notes: notes ? notes : null,
    },
  });

  return NextResponse.json({ skill }, { status: 201 });
}
