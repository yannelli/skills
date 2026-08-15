import { prisma } from "@/lib/prisma";
import { SkillsBoard } from "./skills-board";

export const dynamic = "force-dynamic";

export default async function Home() {
  const skills = await prisma.skill.findMany({
    orderBy: [{ proficiency: "desc" }, { createdAt: "desc" }],
  });

  const serialized = skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    proficiency: skill.proficiency,
    notes: skill.notes,
  }));

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">yannelli/skills</p>
        <h1>Skills Tracker</h1>
        <p className="subtitle">
          Log what you are learning, rate your confidence, and watch your
          toolkit grow.
        </p>
      </header>
      <SkillsBoard initialSkills={serialized} />
      <footer className="footer">
        Built with Next.js, Prisma, and SQLite.
      </footer>
    </main>
  );
}
