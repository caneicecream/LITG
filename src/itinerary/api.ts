import { z } from "zod";
import { itineraryInputSchema } from "./types";

/** Body for saving an itinerary or a new version of one. */
export const saveItineraryBody = z.object({
  name: z.string().trim().min(1).max(100),
  tripId: z.string().max(100).nullable().default(null),
  note: z.string().trim().max(200).default("Generated"),
  input: itineraryInputSchema,
});
