import type { Catalog } from "@/domain/types";

/**
 * Milestone-1 catalog: a deliberately small subset of Walt Disney World resorts.
 * This file describes *structure* (names, tiers, room types, occupancy), not
 * prices. Occupancy figures are from general knowledge and kept conservative;
 * verify on the booking site. Convenience ratings are subjective editorial
 * assumptions used only by the adjustable "best value" score.
 */
export const CATALOG: Catalog = {
  resorts: [
    {
      id: "pop-century",
      name: "Disney's Pop Century Resort",
      tier: "value",
      onProperty: true,
      roomTypes: [{ id: "standard", name: "Standard Room", maxOccupancy: 4 }],
      convenience: 3,
      transportNote: "Disney Skyliner and buses (included)",
    },
    {
      id: "all-star-movies",
      name: "Disney's All-Star Movies Resort",
      tier: "value",
      onProperty: true,
      roomTypes: [{ id: "standard", name: "Standard Room", maxOccupancy: 4 }],
      convenience: 2,
      transportNote: "Disney buses (included)",
    },
    {
      id: "art-of-animation",
      name: "Disney's Art of Animation Resort",
      tier: "value",
      onProperty: true,
      roomTypes: [
        { id: "standard", name: "Little Mermaid Standard Room", maxOccupancy: 4 },
        { id: "family-suite", name: "Family Suite", maxOccupancy: 6 },
      ],
      convenience: 3,
      transportNote: "Disney Skyliner and buses (included)",
    },
    {
      id: "caribbean-beach",
      name: "Disney's Caribbean Beach Resort",
      tier: "moderate",
      onProperty: true,
      roomTypes: [{ id: "standard", name: "Standard Room", maxOccupancy: 4 }],
      convenience: 4,
      transportNote: "Disney Skyliner hub and buses (included)",
    },
    {
      id: "coronado-springs",
      name: "Disney's Coronado Springs Resort",
      tier: "moderate",
      onProperty: true,
      roomTypes: [{ id: "standard", name: "Standard Room", maxOccupancy: 4 }],
      convenience: 3,
      transportNote: "Disney buses (included)",
    },
    {
      id: "yacht-club",
      name: "Disney's Yacht Club Resort",
      tier: "deluxe",
      onProperty: true,
      roomTypes: [{ id: "standard", name: "Standard View Room", maxOccupancy: 5 }],
      convenience: 5,
      transportNote: "Walk/boat to EPCOT and Hollywood Studios; buses (included)",
    },
    {
      id: "contemporary",
      name: "Disney's Contemporary Resort",
      tier: "deluxe",
      onProperty: true,
      roomTypes: [{ id: "standard", name: "Standard View Room", maxOccupancy: 5 }],
      convenience: 5,
      transportNote: "Walk/monorail to Magic Kingdom; buses (included)",
    },
    {
      id: "off-property",
      name: "Off-property hotel (your choice)",
      tier: "off_property",
      onProperty: false,
      roomTypes: [{ id: "standard", name: "Standard Room", maxOccupancy: 4 }],
      convenience: 1,
      transportNote: "Drive or rideshare to the parks",
    },
  ],
};

export function findResort(id: string) {
  return CATALOG.resorts.find((r) => r.id === id);
}
