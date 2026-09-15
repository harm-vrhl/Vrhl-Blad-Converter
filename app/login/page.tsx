"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Inloggen lukte niet.");
      // Alleen een pad binnen deze app, nooit een adres dat iemand in de URL zette.
      const terug = params.get("terug") ?? "/";
      window.location.assign(terug.startsWith("/") && !terug.startsWith("//") ? terug : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center px-6">
      <form onSubmit={submit} className="grid w-full max-w-sm gap-4">
        <h1 className="flex items-baseline gap-2 text-sm tracking-tight">
          <span className="font-semibold">Vrhl</span>
          <span className="text-muted-foreground">Blad</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Vul het wachtwoord van de redactie in.
        </p>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          aria-label="Wachtwoord"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button type="submit" disabled={busy || !password}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Inloggen
        </Button>
      </form>
    </div>
  );
}
