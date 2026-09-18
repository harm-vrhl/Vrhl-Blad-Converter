"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { cn } from "cn";
import { BookOpen } from "lucide-react";
import { WisOpslag } from "@/components/article/WisOpslag";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** Het startscherm van de magazinestand: de vraag en het sleepvak. */
export function MagazineStart({
  modeSwitch,
  notice,
  dragging,
  setDragging,
  accept,
}: {
  modeSwitch: ReactNode;
  notice: string | null;
  dragging: boolean;
  setDragging: Dispatch<SetStateAction<boolean>>;
  accept: (next: File) => Promise<void>;
}) {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col items-center justify-center px-6 py-16">
      <h2 className="text-center text-3xl font-semibold tracking-tight">Wat zullen we omzetten?</h2>
      <p className="mt-2 text-center text-sm text-muted-foreground">
        Een volledig magazine. We zoeken uit waar de artikelen staan, jij kiest welke.
      </p>
      <div className="mt-6">{modeSwitch}</div>
      {notice ? (
        <Alert variant="destructive" className="mt-8 w-full">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      <label
        data-tour="dropzone"
        htmlFor="magazine-upload"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped) void accept(dropped);
        }}
        className={cn(
          "mt-8 flex min-h-64 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-8 py-12 text-center transition-colors",
          dragging
            ? "cursor-copy border-foreground bg-muted text-foreground"
            : "cursor-pointer border-muted-foreground/30 bg-card/60 text-muted-foreground hover:border-muted-foreground/55 hover:bg-muted/50",
        )}
      >
        <span className={cn("flex size-14 items-center justify-center rounded-full", dragging ? "bg-foreground/10" : "bg-muted")}>
          <BookOpen className="size-6" />
        </span>
        <span className="grid gap-1">
          <span className="text-sm font-medium text-foreground">
            {dragging ? "Laat los om te beginnen" : "Sleep je magazine hierheen"}
          </span>
          <span className="text-xs">of klik om een bestand te kiezen</span>
        </span>
        <span className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-medium tracking-wide">PDF</span>
      </label>
      <WisOpslag auto />
      <input
        id="magazine-upload"
        className="sr-only"
        type="file"
        accept=".pdf,application/pdf"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) void accept(picked);
          e.target.value = "";
        }}
      />
    </div>
  );
}
