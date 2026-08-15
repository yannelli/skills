import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const seedSkills = [
  { name: "TypeScript", category: "Languages", proficiency: 4, notes: "Daily driver." },
  { name: "Prisma ORM", category: "Databases", proficiency: 3, notes: "Type-safe queries." },
  { name: "Next.js App Router", category: "Frameworks", proficiency: 4, notes: "Server components." },
];

async function main() {
  const count = await prisma.skill.count();
  if (count > 0) {
    console.log(`Seed skipped: ${count} skill(s) already present.`);
    return;
  }

  await prisma.skill.createMany({ data: seedSkills });
  console.log(`Seeded ${seedSkills.length} skills.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
