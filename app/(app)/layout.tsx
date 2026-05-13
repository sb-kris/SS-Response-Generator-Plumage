import { AppHeader } from "@/components/shared/AppHeader";
import { GenerationRunningBanner } from "@/components/shared/GenerationRunningBanner";

export default function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <GenerationRunningBanner />
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
