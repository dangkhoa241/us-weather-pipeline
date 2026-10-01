import "./lib/zodConfig";   // must stay first: configures Zod before any schema is created
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import { startUrlSync } from "@/store/filters";
import { isSnapshot } from "@/lib/api";
import { initSnapshot } from "@/lib/snapshot";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false } },
});

const root = createRoot(document.getElementById("root")!);

async function start() {
  // The static demo loads its snapshot manifest first, so date presets count back from the snapshot's last day.
  if (isSnapshot) await initSnapshot();
  startUrlSync();
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

start().catch((err: Error) => {
  root.render(<p className="p-6 text-sm text-destructive">Could not start the dashboard: {err.message}</p>);
});
