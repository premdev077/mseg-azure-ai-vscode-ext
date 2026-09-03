/**
 * Reasoning effort, on its own so it can be shared without a cycle.
 *
 * It used to live in `azureClient`, which imports `config`, which imports the
 * mode profiles, which need this type — a three-file loop that dependency
 * analysis flagged and that nothing else would have caught. A leaf module with
 * no imports of its own breaks it.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';
