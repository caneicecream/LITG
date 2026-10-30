import { Suspense } from "react";
import { AssistantPage } from "@/components/assistant/AssistantPage";

export default function Assistant() {
  return (
    <Suspense>
      <AssistantPage />
    </Suspense>
  );
}
