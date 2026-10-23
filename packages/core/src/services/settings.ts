import type { Db } from '../db.ts';
import type { DailyMinimum } from '../types.ts';

export interface Settings {
  /** FSRS target probability of recall at review time. */
  desiredRetention: number;
  maximumInterval: number;
  newCardsPerDay: number;
  learningSteps: string[];
  relearningSteps: string[];
  /** Learning cards due within this many minutes count as due now (keeps sessions flowing). */
  learnAheadMinutes: number;
  /** Optimised FSRS weights, when available. */
  fsrsWeights: number[] | null;
  /** "Just 10 minutes" starter session length. */
  starterMinutes: number;
  /** Focus block and the break after it. */
  focusMinutes: number;
  breakMinutes: number;
  /** The low bar that keeps the chain going. */
  dailyMinimum: DailyMinimum;
}

export const DEFAULT_SETTINGS: Settings = {
  desiredRetention: 0.9,
  maximumInterval: 36500,
  newCardsPerDay: 20,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  learnAheadMinutes: 20,
  fsrsWeights: null,
  starterMinutes: 10,
  focusMinutes: 45,
  breakMinutes: 10,
  dailyMinimum: { kind: 'sessions', value: 1 },
};

export function createSettings(db: Db) {
  function get(): Settings {
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
      if (r.key in DEFAULT_SETTINGS) out[r.key] = JSON.parse(r.value);
    }
    return out as unknown as Settings;
  }
  function set(patch: Partial<Settings>): Settings {
    db.tx(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
        db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
          k,
          JSON.stringify(v),
        ]);
      }
    });
    return get();
  }
  /** Raw key/value access for non-scheduling settings (auth secrets etc.). */
  function getRaw<T>(key: string): T | null {
    const r = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return r ? (JSON.parse(r.value) as T) : null;
  }
  function setRaw(key: string, value: unknown): void {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
      key,
      JSON.stringify(value),
    ]);
  }
  return { get, set, getRaw, setRaw };
}
export type SettingsService = ReturnType<typeof createSettings>;
