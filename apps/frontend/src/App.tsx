import { Button } from "@/components/ui/button";

export default function App() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <h1 className="font-heading text-2xl font-semibold">Axon Console</h1>
      <p className="text-muted-foreground text-sm">
        Frontend scaffold. Replace this with the management console.
      </p>
      <Button>Verify shadcn setup</Button>
    </main>
  );
}
