"use client";

import { create } from "zustand";
import type { Survey, Question } from "@/lib/surveysparrow/types";

// Loading state for async data. We deliberately separate `loading` and `error`
// so the UI can render an inline retry without flickering through a loading
// state during error → retry transitions.
export type AsyncStatus = "idle" | "loading" | "ok" | "error";

interface AsyncResource<T> {
  status: AsyncStatus;
  data: T | null;
  error: string | null;
  fetchedAt: number | null;
  // Whether the data we have was returned partially (e.g. paged result truncated)
  truncated?: boolean;
}

const idleResource = <T>(): AsyncResource<T> => ({
  status: "idle",
  data: null,
  error: null,
  fetchedAt: null,
});

interface SurveyStore {
  // List of all surveys for the connected workspace
  surveys: AsyncResource<Survey[]>;
  // Selected survey ID
  selectedSurveyId: number | null;
  // Questions for the selected survey
  questions: AsyncResource<Question[]>;
  // True if the current `questions` payload was served from IndexedDB cache
  questionsFromCache: boolean;

  setSurveys: (next: Partial<AsyncResource<Survey[]>>) => void;
  resetSurveys: () => void;

  selectSurvey: (id: number | null) => void;
  setQuestions: (next: Partial<AsyncResource<Question[]>>, fromCache?: boolean) => void;
  resetQuestions: () => void;

  reset: () => void;
}

export const useSurveyStore = create<SurveyStore>((set) => ({
  surveys: idleResource<Survey[]>(),
  selectedSurveyId: null,
  questions: idleResource<Question[]>(),
  questionsFromCache: false,

  setSurveys: (next) =>
    set((s) => ({ surveys: { ...s.surveys, ...next } })),
  resetSurveys: () =>
    set({
      surveys: idleResource<Survey[]>(),
      selectedSurveyId: null,
      questions: idleResource<Question[]>(),
      questionsFromCache: false,
    }),

  selectSurvey: (id) =>
    set((s) =>
      // Only reset questions if the selection actually changes. Re-selecting the
      // same survey is a no-op.
      s.selectedSurveyId === id
        ? {}
        : {
            selectedSurveyId: id,
            questions: idleResource<Question[]>(),
            questionsFromCache: false,
          },
    ),
  setQuestions: (next, fromCache = false) =>
    set((s) => ({
      questions: { ...s.questions, ...next },
      questionsFromCache: fromCache,
    })),
  resetQuestions: () =>
    set({
      questions: idleResource<Question[]>(),
      questionsFromCache: false,
    }),

  reset: () =>
    set({
      surveys: idleResource<Survey[]>(),
      selectedSurveyId: null,
      questions: idleResource<Question[]>(),
      questionsFromCache: false,
    }),
}));
