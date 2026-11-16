/**
 * How the work behind a saved note ended. The one definition: the save route's
 * request check, the save_memory tool schema and the stored wording import it
 * (docs/architecture/state-machines.md).
 */
export const MEMORY_OUTCOMES = ['success', 'failure', 'mixed'] as const;
export type MemoryOutcome = typeof MEMORY_OUTCOMES[number];

export const MEMORY_OUTCOME_LABELS: Record<MemoryOutcome, string> = {
  success: 'Succeeded',
  failure: 'Failed',
  mixed: 'Partly succeeded',
};

/** Concept on every note saved with a lesson, so a search can select lessons alone. */
export const LESSON_CONCEPT = 'lesson';

export function memoryOutcomeConcept(outcome: MemoryOutcome): string {
  return `outcome-${outcome}`;
}
