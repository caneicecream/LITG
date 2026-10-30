import { Suspense } from "react";
import { Planner } from "@/components/Planner";

export default function Home() {
  return (
    <Suspense>
      <Planner />
    </Suspense>
  );
}
