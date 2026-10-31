import { ItineraryPlanner } from "@/components/itinerary/ItineraryPlanner";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ItineraryPlanner savedId={id} />;
}
