export default function App() {
  const installerUrl = new URL("/axon/install.sh", window.location.origin).href;
  const installCommand = `curl --proto '=https' --tlsv1.2 -fsSL ${installerUrl} | sh`;

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <section aria-labelledby="axon-title" className="w-full max-w-3xl space-y-8">
        <header className="space-y-3">
          <h1 id="axon-title" className="font-heading text-4xl font-semibold tracking-tight">
            Axon
          </h1>
          <p className="text-muted-foreground">Your coding agent, in the terminal.</p>
        </header>

        <div className="space-y-3">
          <h2 className="text-lg font-medium">Install the CLI</h2>
          <p className="text-muted-foreground text-sm">Run this command in your terminal:</p>
          <pre className="bg-muted overflow-x-auto rounded-lg border p-4 text-sm">
            <code>{installCommand}</code>
          </pre>
          <a
            href={installerUrl}
            download="install.sh"
            className="hover:bg-muted focus-visible:outline-ring inline-flex rounded-md border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Download install.sh
          </a>
        </div>
      </section>
    </main>
  );
}
