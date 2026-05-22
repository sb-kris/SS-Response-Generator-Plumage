// Registry of SurveySparrow question types, normalized by Plumage.
//
// SS uses PascalCase types like "MultiChoice", "OpinionScale", "TextInput",
// plus snake_case variants in some workspaces. We match case-insensitively and
// strip non-alphanumerics so "Multi Choice", "multi_choice", and "MultiChoice"
// all resolve the same way.
//
// `bucket` powers the question-type summary in the preview header.
// `answerable` is the source of truth for "should the LLM generate content
// for this question?" — non-answerable types render a gray badge.

import type { LucideIcon } from "lucide-react";
import {
  ListChecks,
  Star,
  Type,
  Hash,
  Calendar,
  Phone,
  Mail,
  Mic,
  Video,
  Upload,
  Smile,
  IdCard,
  ScrollText,
  Image as ImageIcon,
  Hand,
  HelpCircle,
} from "lucide-react";

export type QuestionTypeBucket =
  | "open_text"
  | "rating"
  | "multiple_choice"
  | "matrix"
  | "screen" // welcome / thank-you / message / consent — no respondent answer
  | "file"
  | "voice"
  | "video"
  | "contact"
  | "other";

export interface QuestionTypeMeta {
  /** Canonical normalized id (e.g. "multichoice") used for matching. */
  canonical: string;
  /** Display label ("Multi choice", "Opinion scale"). */
  label: string;
  bucket: QuestionTypeBucket;
  /** Whether the LLM should generate a response value for this type. */
  answerable: boolean;
  icon: LucideIcon;
}

interface RegistryEntry extends Omit<QuestionTypeMeta, "canonical"> {
  /** Aliases — case-insensitive, non-alphanumerics stripped before match. */
  aliases: string[];
}

// Normalize a type string: lowercase + strip everything that isn't a letter
// or digit. "Multi Choice" / "multi_choice" / "MultiChoice" → "multichoice".
function normalize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Order matters: we match on first alias that's contained in the normalized
// input, so put longer / more-specific aliases before generic ones.
const REGISTRY: RegistryEntry[] = [
  // --- Follow-up questions (text answers tied to a parent's score) ---------
  // MUST come before the generic "nps" alias below, because "npsfeedback"
  // also contains "nps" — without this specific entry, NPSFeedback gets
  // classified as an NPS rating (integer) and the LLM produces a number
  // for an open-text follow-up. End result is "Not Answered" in the SS UI.
  {
    aliases: ["npsfeedback"],
    label: "NPS follow-up",
    bucket: "open_text",
    answerable: true,
    icon: Type,
  },
  {
    aliases: ["csatfeedback"],
    label: "CSAT follow-up",
    bucket: "open_text",
    answerable: true,
    icon: Type,
  },
  {
    aliases: ["cesfeedback"],
    label: "CES follow-up",
    bucket: "open_text",
    answerable: true,
    icon: Type,
  },

  // --- Ratings / scales -----------------------------------------------------
  {
    aliases: ["nps"],
    label: "NPS",
    bucket: "rating",
    answerable: true,
    icon: Star,
  },
  {
    aliases: ["csat"],
    label: "CSAT",
    bucket: "rating",
    answerable: true,
    icon: Star,
  },
  {
    aliases: ["ces"],
    label: "CES",
    bucket: "rating",
    answerable: true,
    icon: Star,
  },
  {
    aliases: ["opinionscale"],
    label: "Opinion scale",
    bucket: "rating",
    answerable: true,
    icon: Star,
  },
  {
    aliases: ["grouprating", "group_rating", "groupratingscale"],
    label: "Group rating",
    bucket: "rating",
    answerable: true,
    icon: Star,
  },
  {
    aliases: ["rating"],
    label: "Rating",
    bucket: "rating",
    answerable: true,
    icon: Star,
  },
  {
    aliases: ["slider"],
    label: "Slider",
    bucket: "rating",
    answerable: true,
    icon: Star,
  },
  {
    aliases: ["smiley"],
    label: "Smiley",
    bucket: "rating",
    answerable: true,
    icon: Smile,
  },

  // --- Multiple choice ------------------------------------------------------
  {
    aliases: ["multichoice", "multipleansweroptions"],
    label: "Multi choice",
    bucket: "multiple_choice",
    answerable: true,
    icon: ListChecks,
  },
  {
    aliases: ["radiochoice", "radio", "singlechoice"],
    label: "Single choice",
    bucket: "multiple_choice",
    answerable: true,
    icon: ListChecks,
  },
  {
    aliases: ["dropdown", "select"],
    label: "Dropdown",
    bucket: "multiple_choice",
    answerable: true,
    icon: ListChecks,
  },
  {
    aliases: ["picturechoice", "imagechoice"],
    label: "Picture choice",
    bucket: "multiple_choice",
    answerable: true,
    icon: ImageIcon,
  },
  {
    aliases: ["yesno"],
    label: "Yes / No",
    bucket: "multiple_choice",
    answerable: true,
    icon: ListChecks,
  },
  {
    aliases: ["rankorder", "ranking"],
    label: "Rank order",
    bucket: "multiple_choice",
    answerable: true,
    icon: ListChecks,
  },
  {
    aliases: ["constantsum", "constsum"],
    label: "Constant sum",
    bucket: "multiple_choice",
    answerable: true,
    icon: Hash,
  },

  // --- Matrix ---------------------------------------------------------------
  {
    aliases: ["matrix", "matrixgrid", "bipolarmatrix"],
    label: "Matrix",
    bucket: "matrix",
    answerable: true,
    icon: ListChecks,
  },

  // --- Open text ------------------------------------------------------------
  {
    aliases: ["textinput", "text", "longtext", "shorttext", "comment"],
    label: "Text",
    bucket: "open_text",
    answerable: true,
    icon: Type,
  },
  {
    aliases: ["number", "numeric"],
    label: "Number",
    bucket: "open_text",
    answerable: true,
    icon: Hash,
  },
  {
    aliases: ["date", "datetime"],
    label: "Date",
    bucket: "open_text",
    answerable: true,
    icon: Calendar,
  },
  {
    aliases: ["url", "website", "link"],
    label: "URL",
    bucket: "open_text",
    answerable: true,
    icon: Type,
  },

  // --- Contact-style (auto-fillable from persona metadata, NOT LLM-generated)
  {
    aliases: ["contact", "contactform"],
    label: "Contact form",
    bucket: "contact",
    answerable: false,
    icon: IdCard,
  },
  {
    aliases: ["email"],
    label: "Email",
    bucket: "contact",
    answerable: false,
    icon: Mail,
  },
  {
    aliases: ["phone", "phonenumber"],
    label: "Phone",
    bucket: "contact",
    answerable: false,
    icon: Phone,
  },
  {
    aliases: ["address"],
    label: "Address",
    bucket: "contact",
    answerable: false,
    icon: IdCard,
  },

  // --- Screen / non-answerable ---------------------------------------------
  {
    aliases: ["welcome", "welcomescreen"],
    label: "Welcome screen",
    bucket: "screen",
    answerable: false,
    icon: Hand,
  },
  {
    aliases: ["thankyou", "endscreen", "thankyouscreen"],
    label: "Thank-you screen",
    bucket: "screen",
    answerable: false,
    icon: Hand,
  },
  {
    aliases: ["message", "info", "statement", "consent"],
    label: "Message",
    bucket: "screen",
    answerable: false,
    icon: ScrollText,
  },

  // --- Media / unsupported --------------------------------------------------
  {
    aliases: ["fileupload", "file"],
    label: "File upload",
    bucket: "file",
    answerable: false,
    icon: Upload,
  },
  {
    aliases: ["audio", "voice", "audiotranscription", "aivoice"],
    label: "Voice",
    bucket: "voice",
    answerable: false,
    icon: Mic,
  },
  {
    aliases: ["video"],
    label: "Video",
    bucket: "video",
    answerable: false,
    icon: Video,
  },
];

const UNKNOWN: QuestionTypeMeta = {
  canonical: "unknown",
  label: "Unknown",
  bucket: "other",
  answerable: true, // Be permissive — better to over-generate than skip silently.
  icon: HelpCircle,
};

const cache = new Map<string, QuestionTypeMeta>();

export function getQuestionTypeMeta(rawType: string): QuestionTypeMeta {
  const key = normalize(rawType);
  if (!key) return UNKNOWN;
  const cached = cache.get(key);
  if (cached) return cached;

  for (const entry of REGISTRY) {
    for (const alias of entry.aliases) {
      if (key.includes(alias)) {
        const meta: QuestionTypeMeta = {
          canonical: alias,
          label: entry.label,
          bucket: entry.bucket,
          answerable: entry.answerable,
          icon: entry.icon,
        };
        cache.set(key, meta);
        return meta;
      }
    }
  }

  const fallback: QuestionTypeMeta = { ...UNKNOWN, canonical: key };
  cache.set(key, fallback);
  return fallback;
}

export const BUCKET_LABELS: Record<QuestionTypeBucket, string> = {
  open_text: "open-text",
  rating: "ratings",
  multiple_choice: "multiple choice",
  matrix: "matrix",
  screen: "screens",
  file: "file uploads",
  voice: "voice",
  video: "video",
  contact: "contact",
  other: "other",
};

// Buckets shown in the preview header summary, in display order.
// We deliberately collapse the long-tail of less-common buckets into "other"
// so the summary stays scannable.
const SUMMARY_BUCKETS_PRIMARY: QuestionTypeBucket[] = [
  "open_text",
  "rating",
  "multiple_choice",
];

export interface QuestionBucketCount {
  bucket: QuestionTypeBucket;
  label: string;
  count: number;
  /** True if this bucket's questions are all skipped during generation. */
  allSkipped: boolean;
}

export function summarizeBuckets(
  questions: { type: string }[],
): QuestionBucketCount[] {
  const counts = new Map<QuestionTypeBucket, { count: number; nonAnswerable: number }>();
  for (const q of questions) {
    const meta = getQuestionTypeMeta(q.type);
    const entry = counts.get(meta.bucket) ?? { count: 0, nonAnswerable: 0 };
    entry.count += 1;
    if (!meta.answerable) entry.nonAnswerable += 1;
    counts.set(meta.bucket, entry);
  }

  const ordered: QuestionBucketCount[] = [];
  let otherCount = 0;
  let otherAllSkipped = true;
  for (const bucket of SUMMARY_BUCKETS_PRIMARY) {
    const c = counts.get(bucket);
    if (c && c.count > 0) {
      ordered.push({
        bucket,
        label: BUCKET_LABELS[bucket],
        count: c.count,
        allSkipped: c.nonAnswerable === c.count,
      });
    }
  }
  for (const [bucket, c] of counts.entries()) {
    if (SUMMARY_BUCKETS_PRIMARY.includes(bucket)) continue;
    otherCount += c.count;
    if (c.nonAnswerable !== c.count) otherAllSkipped = false;
  }
  if (otherCount > 0) {
    ordered.push({
      bucket: "other",
      label: BUCKET_LABELS.other,
      count: otherCount,
      allSkipped: otherAllSkipped,
    });
  }
  return ordered;
}
