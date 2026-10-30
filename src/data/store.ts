import type {
  DiningPlanPrice,
  PointChartEntry,
  PointCost,
  Promotion,
  RoomRate,
  StayQuote,
  TicketPrice,
  TicketRule,
  TripRequest,
} from "@/domain/types";
import type { Cents } from "@/domain/money";
import type { Conversation } from "@/ai/types";
import type { RecheckInput } from "./observations";

/**
 * Persistence facade for personal data: price entries (with observation
 * history), saved trips and conversations. Two interchangeable backends:
 *   - JSON file (default, zero setup; monitoring unavailable)
 *   - PostgreSQL when DATABASE_URL is set (append-only observations, monitoring)
 * All access goes through this module; the domain layer never touches storage.
 */

export type PromotionEntry = Promotion & { kind: "promotion" };
export type UserPriceEntry =
  | RoomRate
  | TicketPrice
  | DiningPlanPrice
  | StayQuote
  | PromotionEntry
  | TicketRule
  | PointChartEntry
  | PointCost;

/** Compact snapshot of one optimization run, kept per saved trip (basis for future price monitoring). */
export interface RunSnapshot {
  runAt: string;
  demoMode: boolean;
  comparable: number;
  /** First ranked option (present even when there are too few options for awards). */
  top?: { evaluationId: string; totalCents: Cents; dataStatus: string };
  cheapest?: { evaluationId: string; totalCents: Cents; dataStatus: string };
  bestValue?: { evaluationId: string; totalCents: Cents; dataStatus: string };
  bestAlternative?: { evaluationId: string; totalCents: Cents; savingsCents: Cents };
  baselineTotalCents?: Cents;
}

export interface SavedTrip {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  request: TripRequest;
  runs: RunSnapshot[];
}

export interface StoreFile {
  version: 1;
  prices: UserPriceEntry[];
  trips: SavedTrip[];
  conversations: Conversation[];
}

export const MAX_RUNS_PER_TRIP = 50;

/**
 * Upgrade entries saved by earlier versions. Milestone 1 stay quotes were
 * always tax-inclusive totals (the form said so), so `taxIncluded` defaults to true.
 */
export function migrateEntry(e: UserPriceEntry): UserPriceEntry {
  if (e.kind === "stay_quote" && (e as Partial<StayQuote>).taxIncluded === undefined) return { ...e, taxIncluded: true };
  return e;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type RecheckResult = { ok: true; entry: UserPriceEntry } | { ok: false; error: string };

export interface StoreBackend {
  readonly kind: "json" | "postgres";
  listPrices(): Promise<UserPriceEntry[]>;
  addPrice(entry: Omit<UserPriceEntry, "id">): Promise<UserPriceEntry>;
  addPrices(entries: Omit<UserPriceEntry, "id">[]): Promise<UserPriceEntry[]>;
  recheckPrice(id: string, input: RecheckInput): Promise<RecheckResult>;
  deletePrice(id: string): Promise<boolean>;
  listTrips(): Promise<SavedTrip[]>;
  getTrip(id: string): Promise<SavedTrip | undefined>;
  saveTrip(input: { id?: string; name: string; request: TripRequest; run?: RunSnapshot }): Promise<SavedTrip>;
  deleteTrip(id: string): Promise<boolean>;
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | undefined>;
  saveConversation(conv: Conversation): Promise<Conversation>;
  deleteConversation(id: string): Promise<boolean>;
}

let override: StoreBackend | null = null;
/** Tests can substitute a backend. */
export function setStoreBackend(b: StoreBackend | null) {
  override = b;
}

async function backend(): Promise<StoreBackend> {
  if (override) return override;
  const { appDb } = await import("@/db/pool");
  const db = appDb();
  if (!db) return (await import("./backends/json")).jsonBackend;
  return (await import("./backends/pg")).pgBackendFor(db);
}

/** Which backend is active ("json" or "postgres"). */
export async function storeKind(): Promise<StoreBackend["kind"]> {
  return (await backend()).kind;
}

export const listPrices = async () => (await backend()).listPrices();
export const addPrice = async (entry: Omit<UserPriceEntry, "id">) => (await backend()).addPrice(entry);
/** Add several entries at once (bulk entry). Callers validate all entries first, so this is all-or-nothing. */
export const addPrices = async (entries: Omit<UserPriceEntry, "id">[]) => (await backend()).addPrices(entries);
/** Record a re-check of an entry, keeping the previous observation in its history. */
export const recheckPrice = async (id: string, input: RecheckInput) => (await backend()).recheckPrice(id, input);
export const deletePrice = async (id: string) => (await backend()).deletePrice(id);
export const listTrips = async () => (await backend()).listTrips();
export const getTrip = async (id: string) => (await backend()).getTrip(id);
export const saveTrip = async (input: { id?: string; name: string; request: TripRequest; run?: RunSnapshot }) => (await backend()).saveTrip(input);
export const deleteTrip = async (id: string) => (await backend()).deleteTrip(id);
export const listConversations = async () => (await backend()).listConversations();
export const getConversation = async (id: string) => (await backend()).getConversation(id);
export const saveConversation = async (conv: Conversation) => (await backend()).saveConversation(conv);
export const deleteConversation = async (id: string) => (await backend()).deleteConversation(id);
