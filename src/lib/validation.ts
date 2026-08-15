import { z } from "zod";

export const skillInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80, "Name is too long"),
  category: z.string().trim().min(1).max(40).default("General"),
  proficiency: z.coerce.number().int().min(1).max(5).default(1),
  notes: z.string().trim().max(280).optional().or(z.literal("")),
});

export type SkillInput = z.infer<typeof skillInputSchema>;
