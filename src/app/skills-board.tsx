"use client";

import { useState } from "react";

export type Skill = {
  id: string;
  name: string;
  category: string;
  proficiency: number;
  notes: string | null;
};

const PROFICIENCY_LABELS = [
  "Curious",
  "Beginner",
  "Comfortable",
  "Proficient",
  "Expert",
];

type FormState = {
  name: string;
  category: string;
  proficiency: number;
  notes: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  category: "General",
  proficiency: 3,
  notes: "",
};

export function SkillsBoard({ initialSkills }: { initialSkills: Skill[] }) {
  const [skills, setSkills] = useState<Skill[]>(initialSkills);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(data?.error ?? "Could not add skill");
      }

      const { skill } = (await response.json()) as { skill: Skill };
      setSkills((current) => sortSkills([skill, ...current]));
      setForm(EMPTY_FORM);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Something went wrong",
      );
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(id: string) {
    const previous = skills;
    setSkills((current) => current.filter((skill) => skill.id !== id));

    const response = await fetch(`/api/skills/${id}`, { method: "DELETE" });
    if (!response.ok) {
      setSkills(previous);
      setError("Could not remove skill");
    }
  }

  return (
    <section className="board">
      <form className="card form" onSubmit={handleSubmit}>
        <h2>Add a skill</h2>
        <label>
          <span>Skill</span>
          <input
            required
            value={form.name}
            placeholder="e.g. GraphQL"
            onChange={(event) =>
              setForm((current) => ({ ...current, name: event.target.value }))
            }
          />
        </label>
        <div className="row">
          <label>
            <span>Category</span>
            <input
              value={form.category}
              placeholder="Frameworks"
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  category: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>Confidence: {PROFICIENCY_LABELS[form.proficiency - 1]}</span>
            <input
              type="range"
              min={1}
              max={5}
              value={form.proficiency}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  proficiency: Number(event.target.value),
                }))
              }
            />
          </label>
        </div>
        <label>
          <span>Notes (optional)</span>
          <input
            value={form.notes}
            placeholder="Where are you using it?"
            onChange={(event) =>
              setForm((current) => ({ ...current, notes: event.target.value }))
            }
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add skill"}
        </button>
      </form>

      <div className="list">
        <div className="list-header">
          <h2>Your skills</h2>
          <span className="count">{skills.length}</span>
        </div>
        {skills.length === 0 ? (
          <p className="empty">No skills yet. Add your first one!</p>
        ) : (
          <ul>
            {skills.map((skill) => (
              <li key={skill.id} className="card skill">
                <div className="skill-main">
                  <div className="skill-title">
                    <span className="name">{skill.name}</span>
                    <span className="tag">{skill.category}</span>
                  </div>
                  {skill.notes ? (
                    <p className="notes">{skill.notes}</p>
                  ) : null}
                  <div className="meter" aria-hidden="true">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <span
                        key={index}
                        className={
                          index < skill.proficiency ? "pip filled" : "pip"
                        }
                      />
                    ))}
                    <span className="level">
                      {PROFICIENCY_LABELS[skill.proficiency - 1]}
                    </span>
                  </div>
                </div>
                <button
                  className="remove"
                  aria-label={`Remove ${skill.name}`}
                  onClick={() => handleDelete(skill.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function sortSkills(skills: Skill[]): Skill[] {
  return [...skills].sort((a, b) => b.proficiency - a.proficiency);
}
